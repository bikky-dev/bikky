/**
 * Entity-typing daemon module — Phase 5a of #46.
 *
 * Periodically classifies entities mentioned by facts into a small ontology
 * (service / repo / file / person / organization / infrastructure / tool /
 * concept / environment / artifact / unknown) so the UI can render typed
 * chips and recall can filter by type.
 *
 * Classification results are stored as standalone Qdrant points with
 * kind="entity_type" and a stable ID derived from the entity name. Each tick
 * picks a small batch of untyped entities, runs the classifier, and upserts.
 */

import crypto from "node:crypto";
import { chatCompletion } from "../llm/index.js";
import { entityTypingPrompt, ENTITY_TYPING_PROMPT_DESCRIPTOR, safeParseJson } from "../prompts/index.js";
import * as qdrant from "./qdrant.js";
import type { LogFn } from "./qdrant.js";

const ENTITY_TYPING_INTERVAL_TICKS = 20;
const FACTS_SCAN_LIMIT = 200;
const MAX_ENTITIES_PER_TICK = 5;
const FACTS_PER_ENTITY = 5;

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
let tickCount = 0;

export const setLogger = (fn: LogFn): void => {
  logFn = fn;
};

const entityIdFor = (name: string): string => {
  // Stable, deterministic ID per entity name (lowercase) so repeated
  // classifications of the same entity overwrite the same point.
  // UUID-formatted so Qdrant accepts it.
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
  content: string;
  category: string;
}

const classifyEntity = async (
  entity: string,
  samples: EntityFactSample[],
): Promise<{ type: string; reasoning?: string; confidence?: number } | null> => {
  if (samples.length === 0) return null;
  const rendered = entityTypingPrompt({ entity, facts: samples });
  const raw = await chatCompletion(rendered);
  if (!raw) return null;
  const parsed = safeParseJson<{ type?: string; reasoning?: string; confidence?: number }>(raw);
  if (!parsed?.type) return null;
  const type = parsed.type.toLowerCase();
  if (!VALID_ENTITY_TYPES.has(type)) {
    logFn("DEBUG", `EntityTyping: LLM returned invalid type '${type}' for '${entity}' — skipping`);
    return null;
  }
  return {
    type,
    reasoning: parsed.reasoning,
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
  };
};

const findUntypedEntities = async (): Promise<Map<string, EntityFactSample[]>> => {
  // Scroll recent facts to gather candidate entities + their context.
  const recent = await qdrant.scrollFacts({}, FACTS_SCAN_LIMIT);
  const candidates = new Map<string, EntityFactSample[]>();
  for (const f of recent) {
    for (const e of f.entities || []) {
      if (!e || e.length < 2) continue;
      if (!candidates.has(e)) candidates.set(e, []);
      const arr = candidates.get(e)!;
      if (arr.length < FACTS_PER_ENTITY) {
        arr.push({ content: f.content, category: f.category });
      }
    }
  }

  // Filter out entities that already have a type point in Qdrant.
  const untyped = new Map<string, EntityFactSample[]>();
  for (const [name, facts] of candidates) {
    const id = entityIdFor(name);
    try {
      const result = await qdrant.qdrantRequest(
        "POST",
        `/collections/${qdrant.collection}/points`,
        { ids: [id], with_payload: true },
      ) as { result?: Array<{ id: string }> };
      if (!result.result || result.result.length === 0) {
        untyped.set(name, facts);
      }
    } catch {
      // If lookup fails treat as untyped — the upsert is idempotent.
      untyped.set(name, facts);
    }
    if (untyped.size >= MAX_ENTITIES_PER_TICK) break;
  }
  return untyped;
};

const upsertEntityTypePoint = async (
  entity: string,
  classification: { type: string; reasoning?: string; confidence?: number },
): Promise<void> => {
  const id = entityIdFor(entity);
  const now = new Date().toISOString();
  // The vector is the embedding of the entity NAME — lets us nearest-neighbour
  // entities of the same type later if we want to.
  const vector = await qdrant.embed(entity);
  await qdrant.qdrantRequest("PUT", `/collections/${qdrant.collection}/points`, {
    points: [
      {
        id,
        vector,
        payload: {
          kind: "entity_type",
          entity_name: entity,
          entity_type: classification.type,
          entity_type_reasoning: classification.reasoning ?? null,
          entity_type_confidence: classification.confidence ?? 0.7,
          classified_at: now,
          updated_at: now,
          created_at: now,
        },
      },
    ],
  });
};

export const tick = async (): Promise<void> => {
  tickCount++;
  if (tickCount % ENTITY_TYPING_INTERVAL_TICKS !== 0) return;

  let typed = 0;
  try {
    const untyped = await findUntypedEntities();
    for (const [name, facts] of untyped) {
      try {
        const classification = await classifyEntity(name, facts);
        if (!classification) continue;
        await upsertEntityTypePoint(name, classification);
        typed++;
        logFn(
          "DEBUG",
          `EntityTyping: classified '${name}' as ${classification.type} (confidence ${classification.confidence})`,
        );
      } catch (e) {
        logFn("WARN", `EntityTyping: classify failed for '${name}': ${(e as Error).message}`);
      }
    }
    if (typed > 0) {
      logFn("INFO", `EntityTyping: typed ${typed} entities (prompt v${ENTITY_TYPING_PROMPT_DESCRIPTOR.version})`);
    }
  } catch (e) {
    logFn("WARN", `EntityTyping: tick failed: ${(e as Error).message}`);
  }
};

// Exported for testing only
export const __test = {
  entityIdFor,
  VALID_ENTITY_TYPES,
};
