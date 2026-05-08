/**
 * External API helpers — Qdrant REST client pool, LLM chat, logging.
 *
 * Multi-destination model: write operations resolve to one Destination
 * (see ../routing.ts) and operate against that destination's QdrantClient
 * via the QdrantPool (see ../lib/qdrant-pool.ts). Read/search operations may
 * resolve a search scope and fan out across multiple destinations.
 *
 * The legacy single-Qdrant API is kept around for back-compat where call sites
 * have not yet been refactored — they all route to a "default" destination
 * synthesized from the top-level qdrant_url/qdrant_api_key/collection.
 */

import fs from "node:fs";
import path from "node:path";
import type { QdrantFilter, QdrantGetResult, QdrantScrollResult, QdrantSearchResult } from "./types.js";
import { embed, getEmbeddingDimensions, getEmbeddingConfig, initEmbedding, chatCompletion, initLLM } from "../llm/index.js";
import type { ChatCompletionOpts } from "../llm/index.js";
export type { ResolvedEmbeddingConfig } from "../llm/index.js";
export { embed, getEmbeddingDimensions, getEmbeddingConfig, initEmbedding };

import { createLogger } from "../logger.js";
import { BIKKY_DIR, LOG_DIR, loadConfig, getEffectiveDestinations, type Destination } from "../config.js";
import { QdrantPool } from "../lib/qdrant-pool.js";
import { resolveDestination, buildResolver, type RoutingInput } from "../routing.js";
import { applySessionDestinationOverride } from "../session-destination-override.js";
import type { QdrantLogLevel } from "../lib/qdrant-client.js";

// ---------------------------------------------------------------------------
// Boot dirs / log
// ---------------------------------------------------------------------------

export const MEMORY_DIR = BIKKY_DIR;

fs.mkdirSync(MEMORY_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

export const log = createLogger("memory-mcp", path.join(LOG_DIR, "mcp.log"), {
  maxSize: 2 * 1024 * 1024,
  maxFiles: 3,
});

const qdrantLogAdapter = (level: QdrantLogLevel, msg: string): void => log(level, msg);

// ---------------------------------------------------------------------------
// Runtime state — populated at startup
// ---------------------------------------------------------------------------

export let ready = false;
/**
 * Reason the system is not ready, when known. Set by `setSetupError` from the
 * MCP boot path if `initEmbedding`/`ensureCollection` fails. Surfaced in
 * `requireReady()` and `get_setup_status` so users see an actionable message
 * instead of a generic "setup_required".
 */
export let setupError: string | null = null;

let pool: QdrantPool | null = null;

let llmInitialized = false;

export function setReady(v: boolean): void { ready = v; }
export function setSetupError(v: string | null): void { setupError = v; }

// ---------------------------------------------------------------------------
// Pool lifecycle
// ---------------------------------------------------------------------------

/**
 * (Re)build the destination pool from the current config. Idempotent — safe
 * to call after configure_credentials updates the on-disk config.
 */
export function rebuildPool(): void {
  const cfg = loadConfig();
  const destinations = getEffectiveDestinations(cfg);
  if (destinations.length === 0) {
    pool = null;
    return;
  }
  pool = new QdrantPool(destinations, {
    client: cfg.qdrant_client,
    log: qdrantLogAdapter,
  });
}

export function getPool(): QdrantPool {
  if (!pool) {
    throw new Error(
      "Qdrant pool not initialized — no destinations configured. " +
        "Use configure_credentials or set QDRANT_URL " +
        "(QDRANT_API_KEY is optional for local / self-hosted instances).",
    );
  }
  return pool;
}

/** Whether at least one destination is configured. */
export function hasPool(): boolean {
  return pool !== null;
}

/** All destination names currently in the pool, in registration order. */
export function destinationNames(): string[] {
  return pool?.names() ?? [];
}

/** All Destination objects in the pool. */
export function listDestinations(): Destination[] {
  return pool?.destinations() ?? [];
}

/** True if any destination's collection is confirmed ready. */
export function anyCollectionReady(): boolean {
  if (!pool) return false;
  for (const name of pool.names()) {
    if (pool.isCollectionReady(name)) return true;
  }
  return false;
}

/** Resolve a destination from caller input. Throws if not configured/found. */
export function resolveDest(input: RoutingInput): Destination {
  const destinations = listDestinations();
  return resolveDestination(applySessionDestinationOverride(input, destinations), destinations);
}

/** Build a resolver closure from the current pool's destinations. */
export function makeResolver(): (input: RoutingInput) => Destination {
  const destinations = listDestinations();
  const resolve = buildResolver(destinations);
  return (input: RoutingInput): Destination =>
    resolve(applySessionDestinationOverride(input, destinations));
}

// ---------------------------------------------------------------------------
// LLM Chat Completion (unchanged — single global LLM config)
// ---------------------------------------------------------------------------

export async function chatComplete(systemPrompt: string, userPrompt: string): Promise<string> {
  ensureLLMInitialized();
  const result = await chatCompletion({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 1000,
    temperature: 0.3,
  });

  if (!result) throw new Error("LLM chat completion failed");
  return result;
}

export async function chatCompleteRendered(opts: ChatCompletionOpts): Promise<string> {
  ensureLLMInitialized();
  const result = await chatCompletion(opts);
  if (!result) throw new Error("LLM chat completion failed");
  return result;
}

function ensureLLMInitialized(): void {
  if (llmInitialized) return;
  const cfg = loadConfig();
  initLLM({
    config: {
      provider: cfg.llm.provider,
      model: cfg.llm.model,
      baseUrl: cfg.llm.base_url,
      apiKey: cfg.llm.api_key ?? null,
      fallback: cfg.llm.fallback_provider ?? null,
      extra: cfg.llm.extra ?? {},
      timeoutMs: cfg.llm.timeout_ms,
      retries: cfg.llm.retries,
      retryBaseDelayMs: cfg.llm.retry_base_delay_ms,
    },
    logger: log as (...args: unknown[]) => void,
  });
  llmInitialized = true;
}

// ---------------------------------------------------------------------------
// Qdrant REST helpers — destination-scoped
// ---------------------------------------------------------------------------

export async function qdrantReq<T>(destination: Destination, method: string, urlPath: string, body?: unknown): Promise<T> {
  return getPool().client(destination.name).request<T>(method, urlPath, body);
}

export async function ensureCollection(
  destination: Destination,
  indexes: Array<{ field_name: string; field_schema: string }>,
): Promise<void> {
  await getPool().ensureCollection(destination.name, getEmbeddingDimensions(), indexes);
  log("INFO", `Collection '${destination.collection}' (destination '${destination.name}') ready (vector size ${getEmbeddingDimensions()}, ${indexes.length} indexes)`);
}

/** Run ensureCollection for every destination in the pool. Failures don't stop the loop. */
export async function ensureCollectionsAll(
  indexes: Array<{ field_name: string; field_schema: string }>,
): Promise<Array<{ destination: Destination; ok: boolean; error: string | null }>> {
  const p = getPool();
  const results: Array<{ destination: Destination; ok: boolean; error: string | null }> = [];
  for (const dest of p.destinations()) {
    try {
      await p.ensureCollection(dest.name, getEmbeddingDimensions(), indexes);
      log("INFO", `Collection '${dest.collection}' (destination '${dest.name}') ready`);
      results.push({ destination: dest, ok: true, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("WARN", `ensureCollection failed for destination '${dest.name}': ${msg}`);
      results.push({ destination: dest, ok: false, error: msg });
    }
  }
  return results;
}

export async function qdrantUpsert(destination: Destination, id: string, vector: number[], payload: Record<string, unknown>): Promise<unknown> {
  return qdrantReq<unknown>(destination, "PUT", `/collections/${destination.collection}/points`, {
    points: [{ id, vector, payload }],
  });
}

export async function qdrantSearch(destination: Destination, vector: number[], filter: QdrantFilter | undefined, limit = 5): Promise<QdrantSearchResult> {
  return qdrantReq<QdrantSearchResult>(destination, "POST", `/collections/${destination.collection}/points/search`, {
    vector,
    filter: filter ?? undefined,
    limit,
    with_payload: true,
  });
}

export async function qdrantScroll(destination: Destination, filter: QdrantFilter, limit = 10): Promise<QdrantScrollResult> {
  return qdrantReq<QdrantScrollResult>(destination, "POST", `/collections/${destination.collection}/points/scroll`, {
    filter,
    limit,
    with_payload: true,
  });
}

export async function qdrantSetPayload(destination: Destination, ids: string[], payload: Record<string, unknown>): Promise<unknown> {
  return qdrantReq<unknown>(destination, "POST", `/collections/${destination.collection}/points/payload`, {
    points: ids,
    payload,
  });
}

export async function qdrantGetPoints(destination: Destination, ids: string[]): Promise<QdrantGetResult> {
  return qdrantReq<QdrantGetResult>(destination, "POST", `/collections/${destination.collection}/points`, {
    ids,
    with_payload: true,
  });
}

// ---------------------------------------------------------------------------
// Cross-destination fan-out helpers
// ---------------------------------------------------------------------------

/**
 * Look up a point by ID across every destination. Returns the first hit found
 * (and which destination it lives in), or null. Used by `memory_forget`,
 * `memory_verify`, `memory_report_outcome`, and any other ID-based op where
 * the caller doesn't know upfront which destination owns the ID.
 */
export async function findPointById(id: string): Promise<{ destination: Destination; point: NonNullable<QdrantGetResult["result"]>[number] } | null> {
  const p = getPool();
  // Sequential rather than parallel: most lookups will hit the first / default
  // destination, so we'd waste round-trips by always fanning out.
  for (const dest of p.destinations()) {
    try {
      const res = await qdrantGetPoints(dest, [id]);
      const point = res.result?.[0];
      if (point) return { destination: dest, point };
    } catch {
      // Destination may be down; keep scanning.
      continue;
    }
  }
  return null;
}
