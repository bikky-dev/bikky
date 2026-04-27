/**
 * Relationship Inference
 *
 * Periodic task that infers typed relationships between entities by analysing
 * their shared facts.  Runs inside the consolidation tick cadence.
 *
 * Flow:
 *   1. Scroll all non-superseded facts → build entity co-occurrence map
 *   2. Filter out pairs that already have a `kind: "relation"` fact
 *   3. For the top N pairs by shared-fact count, fetch the actual shared facts
 *   4. Send to a cheap LLM for a 2-4 word relationship label
 *   5. Store via storeFact with kind: "relation", source: "daemon"
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
import type { LogFn, QdrantPayload } from "./qdrant.js";
import { isGenericEntity, mapToCanonical } from "./relations-vocab.js";

// ─── State ───────────────────────────────────────────────────────────────────

let logFn: LogFn = () => {};
let internalTickCount = 0;

const setLogger = (fn: LogFn): void => { logFn = fn; };

// Run every 300 internal ticks.  consolidation.tick calls us every 5 daemon
// ticks (≈25 s each), so effective period ≈ 300 × 25 s ≈ 2 hours.
const TICK_INTERVAL = 300;

// Max relations to infer per cycle (keeps LLM cost bounded)
const MAX_INFER_PER_CYCLE = 3;

// Minimum shared facts before we consider inferring a relation
const MIN_SHARED_FACTS = 2;

// Minimum LLM confidence to store a relation (quality gate)
const MIN_CONFIDENCE = 0.6;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Canonical pair key — alphabetical so (a,b) === (b,a) */
const pairKey = (a: string, b: string): string => {
  const sorted = [a, b].sort();
  return `${sorted[0]}::${sorted[1]}`;
};

interface CoOccurrence {
  entityA: string;
  entityB: string;
  count: number;
  factIds: string[];
}

/**
 * Scroll ALL non-superseded facts in batches and build a co-occurrence map.
 * Returns pairs sorted by count descending.
 */
const buildCoOccurrenceMap = async (): Promise<CoOccurrence[]> => {
  const pairMap = new Map<string, { entityA: string; entityB: string; count: number; factIds: string[] }>();

  let offset: string | null = null;
  const BATCH = 100;
  let totalScrolled = 0;

  // Scroll through all non-superseded, non-relation facts
  for (;;) {
    const body: Record<string, unknown> = {
      filter: {
        must: [
          { is_null: { key: "superseded_by" } },
        ],
        must_not: [
          { key: "kind", match: { value: "relation" } },
        ],
      },
      limit: BATCH,
      with_payload: { include: ["entities"] },
    };
    if (offset) body.offset = offset;

    const result = await qdrant.qdrantRequest(
      "POST",
      `/collections/${qdrant.collection}/points/scroll`,
      body,
    ) as {
      result?: {
        points?: Array<{ id: string; payload?: Partial<QdrantPayload> }>;
        next_page_offset?: string | null;
      };
    };

    const points = result.result?.points || [];
    if (points.length === 0) break;

    for (const pt of points) {
      const entities = (pt.payload?.entities || []).filter((e) => !isGenericEntity(e));
      if (entities.length < 2) continue;

      // Generate all pairs from this fact's entities
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const eA = entities[i]!;
          const eB = entities[j]!;
          const key = pairKey(eA, eB);
          const existing = pairMap.get(key);
          if (existing) {
            existing.count++;
            if (existing.factIds.length < 10) existing.factIds.push(pt.id);
          } else {
            const sorted = [eA, eB].sort();
            pairMap.set(key, {
              entityA: sorted[0]!,
              entityB: sorted[1]!,
              count: 1,
              factIds: [pt.id],
            });
          }
        }
      }
    }

    totalScrolled += points.length;
    offset = result.result?.next_page_offset ?? null;
    if (!offset) break;
  }

  logFn("DEBUG", `Relations: scrolled ${totalScrolled} facts, found ${pairMap.size} co-occurrence pairs`);

  // Sort by count descending
  return Array.from(pairMap.values())
    .filter(p => p.count >= MIN_SHARED_FACTS)
    .sort((a, b) => b.count - a.count);
};

/**
 * Get the set of entity pairs that already have a daemon-inferred relation.
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
          { key: "source", match: { value: "daemon" } },
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
      if (from && to) {
        existing.add(pairKey(from, to));
      }
    }

    offset = result.result?.next_page_offset ?? null;
    if (!offset) break;
  }

  logFn("DEBUG", `Relations: ${existing.size} existing daemon-inferred relations`);
  return existing;
};

/**
 * Fetch the full content of specific fact IDs for the LLM prompt.
 */
const fetchFactContents = async (
  factIds: string[],
): Promise<Array<{ id: string; content: string; category: string }>> => {
  const result = await qdrant.qdrantRequest(
    "POST",
    `/collections/${qdrant.collection}/points`,
    { ids: factIds, with_payload: { include: ["content", "category"] } },
  ) as { result?: Array<{ id: string; payload?: { content?: string; category?: string } }> };

  return (result.result || []).map(pt => ({
    id: pt.id,
    content: pt.payload?.content ?? "",
    category: pt.payload?.category ?? "",
  }));
};

/**
 * Use LLM to infer a relationship label from shared facts.
 * Returns null if the LLM can't determine a meaningful relationship.
 * The LLM decides directionality — `from` is the subject, `to` is the object.
 */
const inferRelation = async (
  entityA: string,
  entityB: string,
  sharedFacts: Array<{ content: string; category: string }>,
): Promise<{ from: string; type: string; to: string; content: string; evidence?: string; confidence?: number; inVocabulary?: boolean; judgment?: { evidence_strength?: number; durability?: string; directionality_clarity?: string } } | null> => {
  const rendered = relationsPrompt({ entityA, entityB, sharedFacts });
  const raw = await chatCompletion(rendered);

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

  // ── Self-judgment quality gates ──────────────────────────────────────────
  if (parsed.judgment) {
    const j = parsed.judgment;

    // Gate 1: durability — reject transient/ephemeral relations
    if (j.durability === "transient" || j.durability === "ephemeral") {
      logFn("DEBUG", `Relations: rejected ${entityA}↔${entityB} — durability="${j.durability}"`);
      return null;
    }

    // Gate 2: directionality — reject ambiguous direction
    if (j.directionality_clarity === "ambiguous") {
      logFn("DEBUG", `Relations: rejected ${entityA}↔${entityB} — ambiguous directionality`);
      return null;
    }

    // Gate 3: evidence strength — reject weak evidence (< 0.5)
    if (typeof j.evidence_strength === "number" && j.evidence_strength < 0.5) {
      logFn("DEBUG", `Relations: rejected ${entityA}↔${entityB} — evidence_strength=${j.evidence_strength}`);
      return null;
    }
  }

  // Validate that from/to are the provided entities (not hallucinated)
  const entities = new Set([entityA.toLowerCase(), entityB.toLowerCase()]);
  const from = parsed.from?.toLowerCase() ?? "";
  const to = parsed.to?.toLowerCase() ?? "";

  if (!entities.has(from) || !entities.has(to) || from === to) {
    logFn("WARN", `Relations: LLM returned invalid from/to for ${entityA}↔${entityB}: from="${parsed.from}", to="${parsed.to}"`);
    return null;
  }

  // Verify evidence quote actually appears in shared facts (anti-hallucination guard).
  if (parsed.evidence) {
    const haystack = sharedFacts.map((f) => f.content).join(" ").toLowerCase();
    const needle = parsed.evidence.toLowerCase().slice(0, 30);
    if (needle.length > 0 && !haystack.includes(needle)) {
      logFn(
        "WARN",
        `Relations: evidence quote not found in source facts for ${entityA}↔${entityB}: "${parsed.evidence.slice(0, 80)}"`,
      );
      return null;
    }
  }

  // Use the LLM's chosen direction (normalised to original casing)
  const resolvedFrom = from === entityA.toLowerCase() ? entityA : entityB;
  const resolvedTo = to === entityA.toLowerCase() ? entityA : entityB;

  // Map LLM type to canonical vocabulary
  const mapped = mapToCanonical(parsed.type);
  if (mapped.changed) {
    logFn("DEBUG", `Relations: mapped type "${parsed.type}" → "${mapped.canonical}"`);
  }

  // Gate 4: reject out-of-vocab relation types — they are almost always noise
  if (!mapped.inVocabulary) {
    logFn("DEBUG", `Relations: rejected ${entityA}↔${entityB} — out-of-vocab type "${parsed.type}"`);
    return null;
  }

  // Gate 5: confidence floor — skip low-confidence relations
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
  if (confidence < MIN_CONFIDENCE) {
    logFn("DEBUG", `Relations: rejected ${entityA}↔${entityB} — confidence ${confidence} < ${MIN_CONFIDENCE}`);
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

/**
 * Store an inferred relation as a memory fact.
 */
const storeRelation = async (
  fromEntity: string,
  toEntity: string,
  relationType: string,
  content: string,
  sharedFactIds: string[],
  extras: { evidence?: string; confidence?: number; inVocabulary?: boolean; judgment?: { evidence_strength?: number; durability?: string; directionality_clarity?: string } } = {},
): Promise<string> => {
  const hash = createHash("sha256")
    .update(`daemon-relation:${pairKey(fromEntity, toEntity)}:${relationType}`)
    .digest("hex");

  const metadata: Record<string, string> = {
    inferred_from: sharedFactIds.slice(0, 5).join(","),
    shared_fact_count: String(sharedFactIds.length),
    inferred_by_prompt: `${RELATIONS_PROMPT_DESCRIPTOR.id}@${RELATIONS_PROMPT_DESCRIPTOR.version}`,
  };
  if (extras.evidence) {
    metadata.evidence_quote = extras.evidence.slice(0, 500);
  }
  if (extras.judgment) {
    const j = extras.judgment;
    if (j.evidence_strength != null) metadata.evidence_strength = String(j.evidence_strength);
    if (j.durability) metadata.durability = j.durability;
    if (j.directionality_clarity) metadata.directionality_clarity = j.directionality_clarity;
  }

  const id = await qdrant.storeFact({
    content,
    category: "team",    // relations are about entity structure
    domain: "work",
    kind: "relation",
    entities: [fromEntity, toEntity],
    source: "daemon",
    confidence: extras.confidence ?? 0.7,
    importance: 0.6,
    content_hash: hash,
    metadata,
    relation: {
      from: fromEntity,
      type: relationType,
      to: toEntity,
    },
  });

  logFn("INFO", `Relations: inferred ${fromEntity} —[${relationType}]→ ${toEntity} (id: ${id})`);
  return id;
};

// ─── Main Tick ───────────────────────────────────────────────────────────────

const tick = async (config: BikkyConfig): Promise<void> => {
  if (!qdrant.isReady()) return;
  if (config.daemon.relation_inference_enabled === false) return;

  internalTickCount++;
  if (internalTickCount % TICK_INTERVAL !== 0) return;

  logFn("DEBUG", "Relations: starting inference cycle");

  try {
    // 1. Build co-occurrence map
    const pairs = await buildCoOccurrenceMap();
    if (pairs.length === 0) {
      logFn("DEBUG", "Relations: no co-occurrence pairs above threshold");
      return;
    }

    // 2. Get existing relations to avoid duplicates
    const existing = await getExistingRelations();

    // 3. Find candidate pairs (not yet inferred)
    const candidates = pairs.filter(p => !existing.has(pairKey(p.entityA, p.entityB)));
    logFn("DEBUG", `Relations: ${candidates.length} candidate pairs (${pairs.length} total above threshold)`);

    if (candidates.length === 0) return;

    // 4. Infer relations for top N candidates
    let inferred = 0;
    for (const candidate of candidates.slice(0, MAX_INFER_PER_CYCLE)) {
      try {
        const facts = await fetchFactContents(candidate.factIds);
        if (facts.length < MIN_SHARED_FACTS) continue;

        const result = await inferRelation(candidate.entityA, candidate.entityB, facts);
        if (!result) continue;

        // Dedup check before storing
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
          candidate.factIds,
          { evidence: result.evidence, confidence: result.confidence, inVocabulary: result.inVocabulary, judgment: result.judgment },
        );
        inferred++;
      } catch (e: unknown) {
        logFn("WARN", `Relations: failed to infer ${candidate.entityA}↔${candidate.entityB}: ${(e as Error).message}`);
      }
    }

    logFn("INFO", `Relations: inference cycle complete — ${inferred} new relations from ${candidates.length} candidates`);
  } catch (e: unknown) {
    logFn("ERROR", `Relations: inference cycle failed: ${(e as Error).message}`);
  }
};

/** Reset state (for testing). */
const _reset = (): void => {
  internalTickCount = 0;
};

export {
  tick,
  setLogger,
  _reset,
  // Exported for testing
  buildCoOccurrenceMap,
  getExistingRelations,
  inferRelation,
  storeRelation,
  pairKey,
};
