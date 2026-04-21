/**
 * Qdrant client for the mem00 daemon — direct HTTP access to Qdrant Cloud.
 * Embedding is handled by ../llm/embedding.ts (config-driven provider abstraction).
 *
 * Credentials: config file (~/.mem00/config.json) → env vars.
 */

import { randomUUID } from "node:crypto";

import { loadConfig } from "../config.js";
import { embed, initEmbedding, getEmbeddingConfig } from "../llm/index.js";
import type { EmbeddingProviderConfig } from "../llm/index.js";

// ---------------------------------------------------------------------------
// Types (local — replaces agent00 ../../types.ts imports)
// ---------------------------------------------------------------------------

export type LogFn = (level: string, ...args: unknown[]) => void;

export interface QdrantPayload {
  content: string;
  category: string;
  domain: string;
  kind: string;
  entities: string[];
  source: string;
  confidence: number;
  importance: number;
  content_hash: string;
  reinforcement_count: number;
  last_reinforced_at: string;
  superseded_by: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string>;
  from_entity?: string;
  relation_type?: string;
  to_entity?: string;
}

export interface StoreFact {
  content: string;
  category: string;
  domain?: string;
  kind?: string;
  entities: string[];
  source?: string;
  confidence?: number;
  importance?: number;
  content_hash: string;
  metadata?: Record<string, string>;
  relation?: { from: string; type: string; to: string } | null;
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  content: string;
  category: string;
  entities: string[];
  confidence: number;
  last_reinforced_at: string;
  created_at: string;
}

export interface QdrantScrollResult {
  id: string;
  content: string;
  category: string;
  entities: string[];
  confidence: number;
  last_reinforced_at: string;
  created_at: string;
}

export interface QdrantSearchFilters {
  category?: string;
  entity?: string;
  since?: string;
  domain?: string;
  source?: string;
}

export interface QdrantScrollFilters {
  categories?: string[];
  olderThan?: string;
  domain?: string;
}

export type DedupAction = "insert" | "skip" | "supersede";

export interface DedupResult {
  action: DedupAction;
  existingId?: string;
  existingCount?: number;
  score?: number;
}

export interface DedupThresholds {
  exactThreshold?: number;
  supersedeThreshold?: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let qdrantUrl: string | null = null;
let qdrantApiKey: string | null = null;
let collection: string = "mem00";
let logFn: LogFn = () => {};

const setLogger = (fn: LogFn): void => { logFn = fn; };
const setEmbeddingConfig = (overrides?: Partial<EmbeddingProviderConfig>): void => {
  if (overrides) initEmbedding(overrides);
};

// ---------------------------------------------------------------------------
// Init — reads credentials from loadConfig()
// ---------------------------------------------------------------------------

const init = (): boolean => {
  const cfg = loadConfig();

  qdrantUrl = cfg.qdrant_url;
  qdrantApiKey = cfg.qdrant_api_key;
  collection = cfg.collection || "mem00";

  if (qdrantUrl) qdrantUrl = qdrantUrl.replace(/\/+$/, "");

  // Initialize embedding provider from config
  const embCfg = initEmbedding({
    provider: cfg.embedding.provider,
    baseUrl: cfg.embedding.base_url,
    model: cfg.embedding.model,
    dimensions: cfg.embedding.dimensions,
    apiKey: cfg.embedding.api_key,
  });
  logFn("INFO", `Embedding provider: ${embCfg.provider}/${embCfg.model} (${embCfg.dimensions}d) @ ${embCfg.baseUrl}`);

  const ready = !!(qdrantUrl && qdrantApiKey);
  if (!ready) {
    logFn("WARN", "Qdrant client: missing credentials (some memory features disabled)");
  }
  return ready;
};

const isReady = (): boolean => !!(qdrantUrl && qdrantApiKey);

// ---------------------------------------------------------------------------
// HTTP requests
// ---------------------------------------------------------------------------

const qdrantRequest = async (method: string, urlPath: string, body?: unknown): Promise<Record<string, unknown>> => {
  const url = `${qdrantUrl}${urlPath}`;
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "api-key": qdrantApiKey!,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Qdrant ${method} ${urlPath} failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<Record<string, unknown>>;
};

// ---------------------------------------------------------------------------
// Read methods
// ---------------------------------------------------------------------------

const searchFacts = async (
  query: string,
  filters: QdrantSearchFilters = {},
  limit = 10,
): Promise<QdrantSearchResult[]> => {
  const vector = await embed(query);

  const must: Record<string, unknown>[] = [
    { is_null: { key: "superseded_by" } },
  ];

  if (filters.category) {
    must.push({ key: "category", match: { value: filters.category } });
  }
  if (filters.entity) {
    must.push({ key: "entities", match: { value: filters.entity } });
  }
  if (filters.since) {
    must.push({ key: "created_at", range: { gte: filters.since } });
  }
  if (filters.domain) {
    must.push({ key: "domain", match: { value: filters.domain } });
  }
  if (filters.source) {
    must.push({ key: "source", match: { value: filters.source } });
  }

  const result = await qdrantRequest("POST", `/collections/${collection}/points/search`, {
    vector,
    filter: { must },
    limit,
    with_payload: true,
  }) as { result?: Array<{ id: string; score: number; payload?: Partial<QdrantPayload> }> };

  return (result.result || []).map((hit) => ({
    id: hit.id,
    score: hit.score,
    content: hit.payload?.content ?? "",
    category: hit.payload?.category ?? "",
    entities: hit.payload?.entities || [],
    confidence: hit.payload?.confidence ?? 0,
    last_reinforced_at: hit.payload?.last_reinforced_at ?? "",
    created_at: hit.payload?.created_at ?? "",
  }));
};

const scrollFacts = async (
  filters: QdrantScrollFilters = {},
  limit = 10,
): Promise<QdrantScrollResult[]> => {
  const must: Record<string, unknown>[] = [
    { is_null: { key: "superseded_by" } },
  ];

  if (filters.categories && filters.categories.length > 0) {
    must.push({
      key: "category",
      match: { any: filters.categories },
    });
  }

  if (filters.olderThan) {
    must.push({
      key: "last_reinforced_at",
      range: { lt: filters.olderThan },
    });
  }

  if (filters.domain) {
    must.push({ key: "domain", match: { value: filters.domain } });
  }

  const result = await qdrantRequest("POST", `/collections/${collection}/points/scroll`, {
    filter: { must },
    limit,
    with_payload: true,
  }) as { result?: { points?: Array<{ id: string; payload?: Partial<QdrantPayload> }> } };

  return (result.result?.points || []).map((pt) => ({
    id: pt.id,
    content: pt.payload?.content ?? "",
    category: pt.payload?.category ?? "",
    entities: pt.payload?.entities || [],
    confidence: pt.payload?.confidence ?? 0,
    last_reinforced_at: pt.payload?.last_reinforced_at ?? "",
    created_at: pt.payload?.created_at ?? "",
  }));
};

// ---------------------------------------------------------------------------
// Write methods
// ---------------------------------------------------------------------------

const storeFact = async (fact: StoreFact): Promise<string> => {
  const vector = await embed(fact.content);
  const now = new Date().toISOString();
  const id = randomUUID();

  const payload: QdrantPayload = {
    content: fact.content,
    category: fact.category,
    domain: fact.domain || "work",
    kind: fact.kind || "fact",
    entities: fact.entities || [],
    source: fact.source || "cortex",
    confidence: fact.confidence ?? 0.7,
    importance: fact.importance ?? 0.5,
    content_hash: fact.content_hash,
    reinforcement_count: 1,
    last_reinforced_at: now,
    superseded_by: null,
    superseded_at: null,
    created_at: now,
    updated_at: now,
    metadata: fact.metadata || {},
  };

  // Add relation fields if present
  if (fact.relation) {
    payload.from_entity = fact.relation.from;
    payload.relation_type = fact.relation.type;
    payload.to_entity = fact.relation.to;
  }

  await qdrantRequest("PUT", `/collections/${collection}/points`, {
    points: [{ id, vector, payload }],
  });

  logFn("DEBUG", `Qdrant: stored fact ${id} [${fact.category}] ${fact.content.slice(0, 60)}`);
  return id;
};

const supersedeFact = async (oldFactId: string, newFactId: string): Promise<void> => {
  const now = new Date().toISOString();
  await qdrantRequest("POST", `/collections/${collection}/points/payload`, {
    payload: {
      superseded_by: newFactId,
      superseded_at: now,
      updated_at: now,
    },
    points: [oldFactId],
  });
  logFn("DEBUG", `Qdrant: superseded fact ${oldFactId} → ${newFactId}`);
};

const reinforceFact = async (factId: string, currentCount: number): Promise<void> => {
  const now = new Date().toISOString();
  await qdrantRequest("POST", `/collections/${collection}/points/payload`, {
    payload: {
      reinforcement_count: (currentCount || 1) + 1,
      last_reinforced_at: now,
      updated_at: now,
    },
    points: [factId],
  });
  logFn("DEBUG", `Qdrant: reinforced fact ${factId}`);
};

const dedupCheck = async (
  content: string,
  contentHashVal: string,
  { exactThreshold = 0.92, supersedeThreshold = 0.80 }: DedupThresholds = {},
): Promise<DedupResult> => {
  // First: hash-based exact check (fast, no embedding)
  try {
    const hashResult = await qdrantRequest("POST", `/collections/${collection}/points/scroll`, {
      filter: {
        must: [
          { key: "content_hash", match: { value: contentHashVal } },
          { is_null: { key: "superseded_by" } },
        ],
      },
      limit: 1,
      with_payload: true,
    }) as { result?: { points?: Array<{ id: string; payload?: Partial<QdrantPayload> }> } };

    const existing = hashResult.result?.points?.[0];
    if (existing) {
      return {
        action: "skip" as DedupAction,
        existingId: existing.id,
        existingCount: existing.payload?.reinforcement_count || 1,
        score: 1.0,
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logFn("WARN", `Qdrant dedup hash check failed: ${msg}`);
  }

  // Second: vector similarity check
  try {
    const vector = await embed(content);
    const searchResult = await qdrantRequest("POST", `/collections/${collection}/points/search`, {
      vector,
      filter: {
        must: [{ is_null: { key: "superseded_by" } }],
      },
      limit: 1,
      with_payload: true,
    }) as { result?: Array<{ id: string; score: number; payload?: Partial<QdrantPayload> }> };

    const top = searchResult.result?.[0];
    if (!top) return { action: "insert" };

    if (top.score >= exactThreshold) {
      return {
        action: "skip",
        existingId: top.id,
        existingCount: top.payload?.reinforcement_count || 1,
        score: top.score,
      };
    }

    if (top.score >= supersedeThreshold) {
      return {
        action: "supersede",
        existingId: top.id,
        existingCount: top.payload?.reinforcement_count || 1,
        score: top.score,
      };
    }

    return { action: "insert" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logFn("WARN", `Qdrant dedup vector check failed: ${msg}`);
    return { action: "insert" }; // fail open — better to duplicate than lose
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  init,
  isReady,
  setLogger,
  setEmbeddingConfig,
  qdrantRequest,
  embed,
  searchFacts,
  scrollFacts,
  storeFact,
  supersedeFact,
  reinforceFact,
  dedupCheck,
  collection,
};
