/**
 * Entity-typing daemon module.
 *
 * Classifies entities from recently changed facts into a small ontology for
 * UI chips and graph filtering. Work is scheduled by wall-clock config and a
 * persistent cursor so cost grows with new memory, not total memory size.
 */

import crypto from "node:crypto";
import { chatCompletion } from "../llm/index.js";
import type { BikkyConfig } from "../config.js";
import { entityTypingPrompt, ENTITY_TYPING_PROMPT_DESCRIPTOR, safeParseJson } from "../prompts/index.js";
import * as qdrant from "./qdrant.js";
import type { LogFn, QdrantScrollResult } from "./qdrant.js";
import {
  isAttemptBackedOff,
  pruneRecentAttempts,
  readMaintenanceState,
  recordMaintenanceRun,
  shouldRunMaintenance,
} from "./maintenance-state.js";
import { isGenericEntity } from "./relations-vocab.js";

const FACTS_SCAN_LIMIT = 200;
const FACTS_PER_ENTITY = 5;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const ENTITY_ATTEMPT_BACKOFF_MS = 24 * 60 * 60 * 1000;

const VALID_ENTITY_TYPES = new Set([
  "service",
  "repo",
  "file",
  "person",
  "organization",
  "infrastructure",
  "tool",
  "concept",
  "environment",
  "artifact",
  "unknown",
]);

let logFn: LogFn = () => {};

export const setLogger = (fn: LogFn): void => {
  logFn = fn;
};

const entityIdFor = (name: string): string => {
  const hash = crypto.createHash("sha256").update(`entity_type:${name.toLowerCase()}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
};

interface EntityFactSample {
  id: string;
  content: string;
  category: string;
  updated_at: string;
  session_id?: string | null;
  workstream_key?: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

interface EntityCandidate {
  name: string;
  facts: EntityFactSample[];
  factIds: string[];
  sessionIds: string[];
  workstreamKeys: string[];
  latestUpdatedAt: string;
}

interface Classification {
  type: string;
  reasoning?: string;
  confidence?: number;
}

const sessionIdFromFact = (fact: EntityFactSample): string | null => {
  if (fact.session_id) return fact.session_id;
  const extracted = fact.metadata.extracted_from_session;
  if (typeof extracted === "string" && extracted.trim()) return extracted;
  const summarized = fact.metadata.summarized_from_session;
  return typeof summarized === "string" && summarized.trim() ? summarized : null;
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];

const buildEntityCandidates = (facts: QdrantScrollResult[]): EntityCandidate[] => {
  const candidates = new Map<string, EntityFactSample[]>();
  for (const fact of facts) {
    for (const entity of fact.entities || []) {
      const name = entity.trim().toLowerCase();
      if (!name || name.length < 2 || isGenericEntity(name)) continue;
      const samples = candidates.get(name) ?? [];
      if (samples.length < FACTS_PER_ENTITY) {
        samples.push({
          id: fact.id,
          content: fact.content,
          category: fact.category,
          updated_at: fact.updated_at || fact.created_at,
          session_id: fact.session_id,
          workstream_key: fact.workstream_key,
          metadata: fact.metadata,
        });
      }
      candidates.set(name, samples);
    }
  }

  return [...candidates.entries()]
    .map(([name, samples]) => ({
      name,
      facts: samples,
      factIds: uniqueStrings(samples.map((sample) => sample.id)),
      sessionIds: uniqueStrings(samples.map(sessionIdFromFact)),
      workstreamKeys: uniqueStrings(samples.map((sample) => sample.workstream_key)),
      latestUpdatedAt: samples
        .map((sample) => sample.updated_at)
        .filter(Boolean)
        .sort()
        .at(-1) ?? "",
    }))
    .sort((a, b) => a.latestUpdatedAt.localeCompare(b.latestUpdatedAt) || a.name.localeCompare(b.name));
};

const deterministicEntityType = (entity: string): Classification | null => {
  const value = entity.trim();
  const lower = value.toLowerCase();

  if (/^https?:\/\//i.test(value) || /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(value)) {
    return { type: "service", reasoning: "deterministic shape: URL or domain", confidence: 0.95 };
  }
  if (/^(?:\.{1,2}\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|py|go|rs|java|sql|sh|css|html)$/i.test(value)) {
    return { type: "file", reasoning: "deterministic shape: file path", confidence: 0.95 };
  }
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value)) {
    return { type: "repo", reasoning: "deterministic shape: owner/repo slug", confidence: 0.9 };
  }
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(value)) {
    return { type: "artifact", reasoning: "deterministic shape: environment variable or constant", confidence: 0.85 };
  }
  if (/^(main|master|develop|development|feat\/[\w.-]+|fix\/[\w.-]+|chore\/[\w.-]+|release\/[\w.-]+)$/i.test(value)) {
    return { type: "artifact", reasoning: "deterministic shape: branch or release ref", confidence: 0.8 };
  }
  if (/^(prod|production|staging|stage|dev|test|local|sandbox)$/i.test(value)) {
    return { type: "environment", reasoning: "deterministic shape: environment name", confidence: 0.85 };
  }
  if (/^(npm|npx|node|bun|pnpm|yarn|git|gh|docker|kubectl|helm|make|python|pip|go|cargo|curl)$/i.test(lower)) {
    return { type: "tool", reasoning: "deterministic shape: CLI tool name", confidence: 0.9 };
  }
  return null;
};

const classifyEntity = async (
  candidate: EntityCandidate,
): Promise<Classification | null> => {
  if (candidate.facts.length === 0) return null;
  const rendered = entityTypingPrompt({
    entity: candidate.name,
    facts: candidate.facts.map((fact) => ({ content: fact.content, category: fact.category })),
  });
  const raw = await chatCompletion({
    ...rendered,
    telemetry: {
      subsystem: "entity-typing",
      ...(candidate.sessionIds.length > 0 ? { session_id: candidate.sessionIds.join(",") } : {}),
      ...(candidate.workstreamKeys.length > 0 ? { workstream_key: candidate.workstreamKeys.join(",") } : {}),
      trigger: "classify_entity",
    },
  });
  if (!raw) return null;
  const parsed = safeParseJson<{ type?: string; reasoning?: string; confidence?: number }>(raw);
  if (!parsed?.type) return null;
  const type = parsed.type.toLowerCase();
  if (!VALID_ENTITY_TYPES.has(type)) {
    logFn("DEBUG", `EntityTyping: LLM returned invalid type '${type}' for '${candidate.name}' — skipping`);
    return null;
  }
  return {
    type,
    reasoning: parsed.reasoning,
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
  };
};

const existingEntityTypeIds = async (ids: string[]): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const result = await qdrant.qdrantRequest(
    "POST",
    `/collections/${qdrant.collection}/points`,
    { ids, with_payload: false },
  ) as { result?: Array<{ id: string }> };
  return new Set((result.result ?? []).map((point) => point.id));
};

const upsertEntityTypePoint = async (
  candidate: EntityCandidate,
  classification: Classification,
  source: "deterministic" | "llm",
): Promise<void> => {
  const id = entityIdFor(candidate.name);
  const now = new Date().toISOString();
  const vector = await qdrant.embed(candidate.name);
  await qdrant.qdrantRequest("PUT", `/collections/${qdrant.collection}/points`, {
    points: [
      {
        id,
        vector,
        payload: {
          kind: "entity_type",
          entity_name: candidate.name,
          entity_type: classification.type,
          entity_type_reasoning: classification.reasoning ?? null,
          entity_type_confidence: classification.confidence ?? 0.7,
          classified_at: now,
          updated_at: now,
          created_at: now,
          source_fact_ids: candidate.factIds,
          ...(candidate.workstreamKeys.length > 0 ? { workstream_key: candidate.workstreamKeys[0] } : {}),
          metadata: {
            classification_source: source,
            classified_by_prompt: `${ENTITY_TYPING_PROMPT_DESCRIPTOR.id}@${ENTITY_TYPING_PROMPT_DESCRIPTOR.version}`,
            triggering_fact_ids: candidate.factIds.join(","),
            ...(candidate.sessionIds.length > 0 ? { triggering_sessions: candidate.sessionIds.join(",") } : {}),
            ...(candidate.workstreamKeys.length > 0 ? { triggering_workstreams: candidate.workstreamKeys.join(",") } : {}),
          },
        },
      },
    ],
  });
};

const maxUpdatedAt = (facts: QdrantScrollResult[], fallback: string): string =>
  facts.map((fact) => fact.updated_at || fact.created_at).filter(Boolean).sort().at(-1) ?? fallback;

export const tick = async (config: BikkyConfig): Promise<void> => {
  if (!config.daemon.entity_typing_enabled) return;
  if (!qdrant.isReady()) return;

  const now = new Date();
  const nowIso = now.toISOString();
  const state = readMaintenanceState(logFn);
  const job = state.jobs.entity_typing;
  const intervalSec = config.daemon.entity_typing_interval_sec ?? 900;
  if (!shouldRunMaintenance(now, job.last_run_at, intervalSec)) return;

  const attempts = pruneRecentAttempts(job.recent_attempts, now, ENTITY_ATTEMPT_BACKOFF_MS);
  const maxEntities = config.daemon.entity_typing_max_entities_per_run ?? 5;
  const since = job.cursor_updated_at ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS).toISOString();

  try {
    const changedFacts = await qdrant.scrollFacts({
      sinceUpdated: since,
      excludeKinds: ["relation"],
      orderBy: { key: "updated_at", direction: "asc" },
    }, FACTS_SCAN_LIMIT);

    if (changedFacts.length === 0) {
      recordMaintenanceRun("entity_typing", {
        job: "entity_typing",
        ran_at: nowIso,
        status: "skipped",
        candidates_seen: 0,
        llm_calls: 0,
        accepted: 0,
        deterministic: 0,
        skipped_reason: "no_changed_facts",
      }, { cursorUpdatedAt: nowIso, recentAttempts: attempts }, logFn);
      return;
    }

    const candidates = buildEntityCandidates(changedFacts);
    const existing = await existingEntityTypeIds(candidates.map((candidate) => entityIdFor(candidate.name)));
    const untyped = candidates
      .filter((candidate) => !existing.has(entityIdFor(candidate.name)))
      .filter((candidate) => !isAttemptBackedOff(attempts, candidate.name, now, ENTITY_ATTEMPT_BACKOFF_MS));

    let accepted = 0;
    let deterministic = 0;
    let llmCalls = 0;
    let failures = 0;

    for (const candidate of untyped.slice(0, maxEntities)) {
      try {
        const deterministicClassification = deterministicEntityType(candidate.name);
        if (deterministicClassification) {
          await upsertEntityTypePoint(candidate, deterministicClassification, "deterministic");
          accepted++;
          deterministic++;
          continue;
        }

        llmCalls++;
        attempts[candidate.name] = nowIso;
        const classification = await classifyEntity(candidate);
        if (!classification) {
          failures++;
          continue;
        }
        await upsertEntityTypePoint(candidate, classification, "llm");
        accepted++;
        logFn(
          "DEBUG",
          `EntityTyping: classified '${candidate.name}' as ${classification.type} (confidence ${classification.confidence})`,
        );
      } catch (e) {
        failures++;
        logFn("WARN", `EntityTyping: classify failed for '${candidate.name}': ${(e as Error).message}`);
      }
    }

    const capped = untyped.length > maxEntities;
    const cursorUpdatedAt = capped || failures > 0 ? job.cursor_updated_at : maxUpdatedAt(changedFacts, nowIso);
    recordMaintenanceRun("entity_typing", {
      job: "entity_typing",
      ran_at: nowIso,
      status: "success",
      candidates_seen: candidates.length,
      llm_calls: llmCalls,
      accepted,
      deterministic,
      skipped_reason: capped ? "max_entities_per_run_reached" : undefined,
    }, { cursorUpdatedAt, recentAttempts: attempts }, logFn);

    if (accepted > 0) {
      logFn("INFO", `EntityTyping: typed ${accepted} entities (${deterministic} deterministic, ${llmCalls} LLM)`);
    }
  } catch (e) {
    recordMaintenanceRun("entity_typing", {
      job: "entity_typing",
      ran_at: nowIso,
      status: "error",
      candidates_seen: 0,
      llm_calls: 0,
      accepted: 0,
      deterministic: 0,
      error: (e as Error).message,
    }, { cursorUpdatedAt: job.cursor_updated_at, recentAttempts: attempts }, logFn);
    logFn("WARN", `EntityTyping: tick failed: ${(e as Error).message}`);
  }
};

// Exported for testing only
export const __test = {
  buildEntityCandidates,
  deterministicEntityType,
  entityIdFor,
  maxUpdatedAt,
  VALID_ENTITY_TYPES,
};
