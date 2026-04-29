/**
 * Relationship inference.
 *
 * Infers typed relationships between entities from recently changed facts. The
 * daemon keeps a persistent cursor so each cycle considers new evidence first
 * instead of rebuilding a whole-collection co-occurrence map.
 */

import { createHash } from "node:crypto";
import * as qdrant from "./qdrant.js";
import { chatCompletion } from "../llm/index.js";
import {
  relationsPrompt,
  RELATIONS_PROMPT_DESCRIPTOR,
  safeParseJson,
} from "../prompts/index.js";
import type { BikkyConfig } from "../config.js";
import type { LogFn, QdrantPayload, QdrantScrollResult } from "./qdrant.js";
import { DEFAULT_CAPTURE_CONTEXT } from "./capture-policy.js";
import { isGenericEntity, mapToCanonical } from "./relations-vocab.js";
import {
  isAttemptBackedOff,
  pruneRecentAttempts,
  readMaintenanceState,
  recordMaintenanceRun,
  shouldRunMaintenance,
} from "./maintenance-state.js";

let logFn: LogFn = () => {};

const setLogger = (fn: LogFn): void => { logFn = fn; };

const CHANGED_FACTS_LIMIT = 200;
const SUPPORTING_FACTS_LIMIT = 10;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const RELATION_ATTEMPT_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;

const MIN_SHARED_FACTS = 2;
const MIN_CONFIDENCE = 0.6;

/** Canonical pair key — alphabetical so (a,b) === (b,a). */
const pairKey = (a: string, b: string): string => {
  const sorted = [a, b].map((entity) => entity.toLowerCase()).sort();
  return `${sorted[0]}::${sorted[1]}`;
};

interface ChangedCoOccurrence {
  entityA: string;
  entityB: string;
  triggeringFactIds: string[];
  latestUpdatedAt: string;
}

interface RelationFact {
  id: string;
  content: string;
  category: string;
  updated_at: string;
  session_id?: string | null;
  workstream_key?: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

interface RelationCandidate {
  entityA: string;
  entityB: string;
  triggeringFactIds: string[];
  supportingFactIds: string[];
  facts: Array<{ id: string; content: string; category: string }>;
  sessionIds: string[];
  workstreamKeys: string[];
  latestUpdatedAt: string;
}

const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];

const sessionIdFromFact = (fact: RelationFact | QdrantScrollResult): string | null => {
  if (fact.session_id) return fact.session_id;
  const extracted = fact.metadata.extracted_from_session;
  if (typeof extracted === "string" && extracted.trim()) return extracted;
  const summarized = fact.metadata.summarized_from_session;
  return typeof summarized === "string" && summarized.trim() ? summarized : null;
};

const buildChangedCoOccurrenceCandidates = (facts: QdrantScrollResult[]): ChangedCoOccurrence[] => {
  const pairMap = new Map<string, ChangedCoOccurrence>();

  for (const fact of facts) {
    const entities = [...new Set((fact.entities || [])
      .map((entity) => entity.trim().toLowerCase())
      .filter((entity) => entity.length >= 2 && !isGenericEntity(entity)))];
    if (entities.length < 2) continue;

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const entityA = entities[i]!;
        const entityB = entities[j]!;
        const key = pairKey(entityA, entityB);
        const sorted = [entityA, entityB].sort();
        const existing = pairMap.get(key);
        if (existing) {
          existing.triggeringFactIds = uniqueStrings([...existing.triggeringFactIds, fact.id]);
          existing.latestUpdatedAt = [existing.latestUpdatedAt, fact.updated_at || fact.created_at].filter(Boolean).sort().at(-1) ?? "";
        } else {
          pairMap.set(key, {
            entityA: sorted[0]!,
            entityB: sorted[1]!,
            triggeringFactIds: [fact.id],
            latestUpdatedAt: fact.updated_at || fact.created_at,
          });
        }
      }
    }
  }

  return [...pairMap.values()]
    .sort((a, b) => a.latestUpdatedAt.localeCompare(b.latestUpdatedAt) || pairKey(a.entityA, a.entityB).localeCompare(pairKey(b.entityA, b.entityB)));
};

/**
 * Get the set of entity pairs that already have a system-inferred relation.
 * Returns a Set of pairKeys.
 */
const getExistingRelations = async (): Promise<Set<string>> => {
  const existing = new Set<string>();

  let offset: string | null = null;
  for (;;) {
    const body: Record<string, unknown> = {
      filter: {
        must: [
          { key: "kind", match: { value: "relation" } },
          { key: "source", match: { any: ["system", "daemon"] } },
          { is_null: { key: "superseded_by" } },
        ],
      },
      limit: 100,
      with_payload: { include: ["from_entity", "to_entity"] },
    };
    if (offset) body.offset = offset;

    const result = await qdrant.qdrantRequest(
      "POST",
      `/collections/${qdrant.collection}/points/scroll`,
      body,
    ) as {
      result?: {
        points?: Array<{ id: string; payload?: { from_entity?: string; to_entity?: string } }>;
        next_page_offset?: string | null;
      };
    };

    const points = result.result?.points || [];
    if (points.length === 0) break;

    for (const pt of points) {
      const from = pt.payload?.from_entity;
      const to = pt.payload?.to_entity;
      if (from && to) existing.add(pairKey(from, to));
    }

    offset = result.result?.next_page_offset ?? null;
    if (!offset) break;
  }

  logFn("DEBUG", `Relations: ${existing.size} existing daemon-inferred relations`);
  return existing;
};

const fetchSupportingFacts = async (
  entityA: string,
  entityB: string,
): Promise<RelationFact[]> => {
  const result = await qdrant.qdrantRequest(
    "POST",
    `/collections/${qdrant.collection}/points/scroll`,
    {
      filter: {
        must: [
          { is_null: { key: "superseded_by" } },
          { key: "entities", match: { value: entityA } },
          { key: "entities", match: { value: entityB } },
        ],
        must_not: [
          { key: "kind", match: { value: "relation" } },
          { key: "kind", match: { value: "entity_type" } },
        ],
      },
      order_by: { key: "updated_at", direction: "desc" },
      limit: SUPPORTING_FACTS_LIMIT,
      with_payload: true,
    },
  ) as { result?: { points?: Array<{ id: string; payload?: Partial<QdrantPayload> }> } };

  return (result.result?.points ?? []).map((point) => ({
    id: point.id,
    content: point.payload?.content ?? "",
    category: point.payload?.category ?? "",
    updated_at: point.payload?.updated_at ?? point.payload?.created_at ?? "",
    session_id: point.payload?.session_id ?? null,
    workstream_key: point.payload?.workstream_key ?? null,
    metadata: point.payload?.metadata ?? {},
  }));
};

const buildRelationCandidate = async (
  changed: ChangedCoOccurrence,
): Promise<RelationCandidate | null> => {
  const supportingFacts = await fetchSupportingFacts(changed.entityA, changed.entityB);
  if (supportingFacts.length < MIN_SHARED_FACTS) return null;

  return {
    entityA: changed.entityA,
    entityB: changed.entityB,
    triggeringFactIds: changed.triggeringFactIds,
    supportingFactIds: supportingFacts.map((fact) => fact.id),
    facts: supportingFacts.map((fact) => ({ id: fact.id, content: fact.content, category: fact.category })),
    sessionIds: uniqueStrings(supportingFacts.map(sessionIdFromFact)),
    workstreamKeys: uniqueStrings(supportingFacts.map((fact) => fact.workstream_key)),
    latestUpdatedAt: [changed.latestUpdatedAt, ...supportingFacts.map((fact) => fact.updated_at)].filter(Boolean).sort().at(-1) ?? "",
  };
};

const inferRelation = async (
  candidate: RelationCandidate,
): Promise<{ from: string; type: string; to: string; content: string; evidence?: string; confidence?: number; inVocabulary?: boolean; judgment?: { evidence_strength?: number; durability?: string; directionality_clarity?: string } } | null> => {
  const rendered = relationsPrompt({
    entityA: candidate.entityA,
    entityB: candidate.entityB,
    sharedFacts: candidate.facts.map((fact) => ({ content: fact.content, category: fact.category })),
  });
  const raw = await chatCompletion({
    ...rendered,
    telemetry: {
      subsystem: "relation-inference",
      ...(candidate.sessionIds.length > 0 ? { session_id: candidate.sessionIds.join(",") } : {}),
      ...(candidate.workstreamKeys.length > 0 ? { workstream_key: candidate.workstreamKeys.join(",") } : {}),
      trigger: "infer_relation",
    },
  });

  if (!raw) return null;

  const parsed = safeParseJson<{
    from?: string | null;
    type?: string | null;
    to?: string | null;
    content?: string;
    evidence?: string;
    confidence?: number;
    reason?: string;
    judgment?: {
      evidence_strength?: number;
      durability?: string;
      directionality_clarity?: string;
    };
  }>(raw);

  if (!parsed || !parsed.type) return null;

  if (parsed.judgment) {
    const j = parsed.judgment;
    if (j.durability === "transient" || j.durability === "ephemeral") {
      logFn("DEBUG", `Relations: rejected ${candidate.entityA}↔${candidate.entityB} — durability="${j.durability}"`);
      return null;
    }
    if (j.directionality_clarity === "ambiguous") {
      logFn("DEBUG", `Relations: rejected ${candidate.entityA}↔${candidate.entityB} — ambiguous directionality`);
      return null;
    }
    if (typeof j.evidence_strength === "number" && j.evidence_strength < 0.5) {
      logFn("DEBUG", `Relations: rejected ${candidate.entityA}↔${candidate.entityB} — evidence_strength=${j.evidence_strength}`);
      return null;
    }
  }

  const entities = new Set([candidate.entityA.toLowerCase(), candidate.entityB.toLowerCase()]);
  const from = parsed.from?.toLowerCase() ?? "";
  const to = parsed.to?.toLowerCase() ?? "";

  if (!entities.has(from) || !entities.has(to) || from === to) {
    logFn("WARN", `Relations: LLM returned invalid from/to for ${candidate.entityA}↔${candidate.entityB}: from="${parsed.from}", to="${parsed.to}"`);
    return null;
  }

  if (parsed.evidence) {
    const haystack = candidate.facts.map((f) => f.content).join(" ").toLowerCase();
    const needle = parsed.evidence.toLowerCase().slice(0, 30);
    if (needle.length > 0 && !haystack.includes(needle)) {
      logFn(
        "WARN",
        `Relations: evidence quote not found in source facts for ${candidate.entityA}↔${candidate.entityB}: "${parsed.evidence.slice(0, 80)}"`,
      );
      return null;
    }
  }

  const resolvedFrom = from === candidate.entityA.toLowerCase() ? candidate.entityA : candidate.entityB;
  const resolvedTo = to === candidate.entityA.toLowerCase() ? candidate.entityA : candidate.entityB;

  const mapped = mapToCanonical(parsed.type);
  if (mapped.changed) {
    logFn("DEBUG", `Relations: mapped type "${parsed.type}" → "${mapped.canonical}"`);
  }
  if (!mapped.inVocabulary) {
    logFn("DEBUG", `Relations: rejected ${candidate.entityA}↔${candidate.entityB} — out-of-vocab type "${parsed.type}"`);
    return null;
  }

  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
  if (confidence < MIN_CONFIDENCE) {
    logFn("DEBUG", `Relations: rejected ${candidate.entityA}↔${candidate.entityB} — confidence ${confidence} < ${MIN_CONFIDENCE}`);
    return null;
  }

  return {
    from: resolvedFrom,
    type: mapped.canonical,
    to: resolvedTo,
    content: parsed.content || `${resolvedFrom} ${mapped.canonical} ${resolvedTo}`,
    evidence: parsed.evidence,
    confidence,
    inVocabulary: mapped.inVocabulary,
    judgment: parsed.judgment,
  };
};

const storeRelation = async (
  fromEntity: string,
  toEntity: string,
  relationType: string,
  content: string,
  candidate: RelationCandidate,
  extras: { evidence?: string; confidence?: number; inVocabulary?: boolean; judgment?: { evidence_strength?: number; durability?: string; directionality_clarity?: string } } = {},
): Promise<string> => {
  const hash = createHash("sha256")
    .update(`daemon-relation:${pairKey(fromEntity, toEntity)}:${relationType}`)
    .digest("hex");

  const metadata: Record<string, string> = {
    inferred_from: candidate.supportingFactIds.slice(0, 5).join(","),
    shared_fact_count: String(candidate.supportingFactIds.length),
    inferred_by_prompt: `${RELATIONS_PROMPT_DESCRIPTOR.id}@${RELATIONS_PROMPT_DESCRIPTOR.version}`,
    triggering_fact_ids: candidate.triggeringFactIds.join(","),
    supporting_fact_ids: candidate.supportingFactIds.join(","),
  };
  if (candidate.sessionIds.length > 0) metadata.triggering_sessions = candidate.sessionIds.join(",");
  if (candidate.workstreamKeys.length > 0) metadata.triggering_workstreams = candidate.workstreamKeys.join(",");
  if (extras.evidence) metadata.evidence_quote = extras.evidence.slice(0, 500);
  if (extras.judgment) {
    const j = extras.judgment;
    if (j.evidence_strength != null) metadata.evidence_strength = String(j.evidence_strength);
    if (j.durability) metadata.durability = j.durability;
    if (j.directionality_clarity) metadata.directionality_clarity = j.directionality_clarity;
  }

  const id = await qdrant.storeFact({
    content,
    category: "human",
    domain: DEFAULT_CAPTURE_CONTEXT.domain,
    kind: "relation",
    entities: [fromEntity, toEntity],
    source: "system",
    confidence: extras.confidence ?? 0.7,
    importance: 0.6,
    content_hash: hash,
    metadata,
    source_fact_ids: candidate.supportingFactIds,
    ...(candidate.workstreamKeys.length > 0 ? { workstream_key: candidate.workstreamKeys[0] } : {}),
    relation: {
      from: fromEntity,
      type: relationType,
      to: toEntity,
    },
  });

  logFn("INFO", `Relations: inferred ${fromEntity} —[${relationType}]→ ${toEntity} (id: ${id})`);
  return id;
};

const tick = async (config: BikkyConfig): Promise<void> => {
  if (!qdrant.isReady()) return;
  if (config.daemon.relation_inference_enabled === false) return;

  const now = new Date();
  const nowIso = now.toISOString();
  const state = readMaintenanceState(logFn);
  const job = state.jobs.relation_inference;
  const intervalSec = config.daemon.relation_inference_interval_sec ?? 7200;
  if (!shouldRunMaintenance(now, job.last_run_at, intervalSec)) return;

  const attempts = pruneRecentAttempts(job.recent_attempts, now, RELATION_ATTEMPT_BACKOFF_MS);
  const maxPairs = config.daemon.relation_inference_max_pairs_per_run ?? 3;
  const since = job.cursor_updated_at ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS).toISOString();

  try {
    const changedFacts = await qdrant.scrollFacts({
      sinceUpdated: since,
      excludeKinds: ["relation"],
      orderBy: { key: "updated_at", direction: "asc" },
    }, CHANGED_FACTS_LIMIT);

    if (changedFacts.length === 0) {
      recordMaintenanceRun("relation_inference", {
        job: "relation_inference",
        ran_at: nowIso,
        status: "skipped",
        candidates_seen: 0,
        llm_calls: 0,
        accepted: 0,
        skipped_reason: "no_changed_facts",
      }, { cursorUpdatedAt: nowIso, recentAttempts: attempts }, logFn);
      return;
    }

    const changedPairs = buildChangedCoOccurrenceCandidates(changedFacts);
    if (changedPairs.length === 0) {
      recordMaintenanceRun("relation_inference", {
        job: "relation_inference",
        ran_at: nowIso,
        status: "skipped",
        candidates_seen: 0,
        llm_calls: 0,
        accepted: 0,
        skipped_reason: "no_entity_pairs",
      }, { cursorUpdatedAt: changedFacts.map((fact) => fact.updated_at || fact.created_at).filter(Boolean).sort().at(-1) ?? nowIso, recentAttempts: attempts }, logFn);
      return;
    }

    const existing = await getExistingRelations();
    const touchedPairs = changedPairs
      .filter((pair) => !existing.has(pairKey(pair.entityA, pair.entityB)))
      .filter((pair) => !isAttemptBackedOff(attempts, pairKey(pair.entityA, pair.entityB), now, RELATION_ATTEMPT_BACKOFF_MS));

    const supportLookupLimit = Math.max(maxPairs * 5, maxPairs);
    const relationCandidates: RelationCandidate[] = [];
    for (const changed of touchedPairs.slice(0, supportLookupLimit)) {
      const candidate = await buildRelationCandidate(changed);
      if (candidate) relationCandidates.push(candidate);
      if (relationCandidates.length >= maxPairs) break;
    }

    let inferred = 0;
    let llmCalls = 0;
    let failures = 0;

    for (const candidate of relationCandidates.slice(0, maxPairs)) {
      const key = pairKey(candidate.entityA, candidate.entityB);
      try {
        llmCalls++;
        attempts[key] = nowIso;
        const result = await inferRelation(candidate);
        if (!result) continue;

        const hash = createHash("sha256")
          .update(`daemon-relation:${pairKey(result.from, result.to)}:${result.type}`)
          .digest("hex");
        const dedup = await qdrant.dedupCheck(result.content, hash);
        if (dedup.action === "skip") {
          logFn("DEBUG", `Relations: skipping duplicate ${candidate.entityA}↔${candidate.entityB}`);
          continue;
        }

        await storeRelation(
          result.from,
          result.to,
          result.type,
          result.content,
          candidate,
          { evidence: result.evidence, confidence: result.confidence, inVocabulary: result.inVocabulary, judgment: result.judgment },
        );
        inferred++;
      } catch (e: unknown) {
        failures++;
        logFn("WARN", `Relations: failed to infer ${candidate.entityA}↔${candidate.entityB}: ${(e as Error).message}`);
      }
    }

    const deferred = failures > 0 || touchedPairs.length > supportLookupLimit || relationCandidates.length > maxPairs;
    const cursorUpdatedAt = deferred ? job.cursor_updated_at : changedFacts.map((fact) => fact.updated_at || fact.created_at).filter(Boolean).sort().at(-1) ?? nowIso;
    recordMaintenanceRun("relation_inference", {
      job: "relation_inference",
      ran_at: nowIso,
      status: "success",
      candidates_seen: touchedPairs.length,
      llm_calls: llmCalls,
      accepted: inferred,
      skipped_reason: deferred ? "work_deferred" : undefined,
    }, { cursorUpdatedAt, recentAttempts: attempts }, logFn);

    logFn("INFO", `Relations: inference cycle complete — ${inferred} new relations from ${touchedPairs.length} changed pair(s)`);
  } catch (e: unknown) {
    recordMaintenanceRun("relation_inference", {
      job: "relation_inference",
      ran_at: nowIso,
      status: "error",
      candidates_seen: 0,
      llm_calls: 0,
      accepted: 0,
      error: (e as Error).message,
    }, { cursorUpdatedAt: job.cursor_updated_at, recentAttempts: attempts }, logFn);
    logFn("ERROR", `Relations: inference cycle failed: ${(e as Error).message}`);
  }
};

/** Reset state (for testing). */
const _reset = (): void => {};

export {
  tick,
  setLogger,
  _reset,
  buildChangedCoOccurrenceCandidates,
  fetchSupportingFacts,
  getExistingRelations,
  inferRelation,
  storeRelation,
  pairKey,
};
