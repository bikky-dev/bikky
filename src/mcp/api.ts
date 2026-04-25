/**
 * External API helpers — Qdrant REST client, LLM chat, logging.
 * Credentials come from config (~/.bikky/config.json) or env vars.
 */

import fs from "node:fs";
import path from "node:path";
import type { QdrantFilter, QdrantGetResult, QdrantScrollResult, QdrantSearchResult } from "./types.js";
import { embed, getEmbeddingDimensions, getEmbeddingConfig, initEmbedding, chatCompletion, initLLM } from "../llm/index.js";
import type { ChatCompletionOpts } from "../llm/index.js";
export type { ResolvedEmbeddingConfig } from "../llm/index.js";
export { embed, getEmbeddingDimensions, getEmbeddingConfig, initEmbedding };

import { createLogger } from "../logger.js";
import { BIKKY_DIR, LOG_DIR, loadConfig } from "../config.js";
import { QdrantClient, type QdrantLogLevel } from "../lib/qdrant-client.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const MEMORY_DIR = BIKKY_DIR;
let collectionName = "bikky";

export function getCollection(): string { return collectionName; }
export function setCollection(name: string): void {
  collectionName = name;
  rebuildClient();
}

fs.mkdirSync(MEMORY_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

let llmInitialized = false;

// ---------------------------------------------------------------------------
// Runtime state — populated at startup
// ---------------------------------------------------------------------------

export let qdrantUrl: string | null = null;
export let qdrantApiKey: string | null = null;
export let ready = false;

let client: QdrantClient | null = null;

export function setQdrantUrl(v: string | null): void {
  qdrantUrl = v ? v.replace(/\/+$/, "") : v;
  rebuildClient();
}
export function setQdrantApiKey(v: string | null): void {
  qdrantApiKey = v;
  rebuildClient();
}
export function setReady(v: boolean): void { ready = v; }

// ---------------------------------------------------------------------------
// Logging (to file only — stdout/stderr are MCP stdio transport)
// ---------------------------------------------------------------------------

export const log = createLogger("memory-mcp", path.join(LOG_DIR, "mcp.log"), {
  maxSize: 2 * 1024 * 1024,
  maxFiles: 3,
});

// Adapter to bridge QdrantClient's QdrantLogFn signature to our file logger.
const qdrantLogAdapter = (level: QdrantLogLevel, msg: string): void => log(level, msg);

function rebuildClient(): void {
  if (qdrantUrl && qdrantApiKey && collectionName) {
    const cfg = loadConfig();
    client = new QdrantClient({
      url: qdrantUrl,
      apiKey: qdrantApiKey,
      collection: collectionName,
      timeoutMs: cfg.qdrant_client.timeout_ms,
      retries: cfg.qdrant_client.retries,
      retryBaseDelayMs: cfg.qdrant_client.retry_base_delay_ms,
      log: qdrantLogAdapter,
    });
  } else {
    client = null;
  }
}

// ---------------------------------------------------------------------------
// LLM Chat Completion (for distillation)
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

/**
 * Run a pre-rendered prompt (from src/prompts/*) through the LLM. The
 * RenderedPrompt already carries messages, response_format, temperature, etc.
 */
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
    },
    logger: log as (...args: unknown[]) => void,
  });
  llmInitialized = true;
}

// ---------------------------------------------------------------------------
// Qdrant REST Client
// ---------------------------------------------------------------------------

function getClient(): QdrantClient {
  if (!client) {
    throw new Error(
      "Qdrant client not initialized — credentials missing. " +
        "Use configure_credentials or set QDRANT_URL + QDRANT_API_KEY.",
    );
  }
  return client;
}

export async function qdrantReq<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
  return getClient().request<T>(method, urlPath, body);
}

export async function ensureCollection(indexes: Array<{ field_name: string; field_schema: string }>): Promise<void> {
  await getClient().ensureCollection(getEmbeddingDimensions(), indexes);
  log("INFO", `Collection '${getCollection()}' ready (vector size ${getEmbeddingDimensions()}, ${indexes.length} indexes)`);
}

export async function qdrantUpsert(id: string, vector: number[], payload: Record<string, unknown>): Promise<unknown> {
  return qdrantReq<unknown>("PUT", `/collections/${getCollection()}/points`, {
    points: [{ id, vector, payload }],
  });
}

export async function qdrantSearch(vector: number[], filter: QdrantFilter | undefined, limit = 5): Promise<QdrantSearchResult> {
  return qdrantReq<QdrantSearchResult>("POST", `/collections/${getCollection()}/points/search`, {
    vector,
    filter: filter ?? undefined,
    limit,
    with_payload: true,
  });
}

export async function qdrantScroll(filter: QdrantFilter, limit = 10): Promise<QdrantScrollResult> {
  return qdrantReq<QdrantScrollResult>("POST", `/collections/${getCollection()}/points/scroll`, {
    filter,
    limit,
    with_payload: true,
  });
}

export async function qdrantSetPayload(ids: string[], payload: Record<string, unknown>): Promise<unknown> {
  return qdrantReq<unknown>("POST", `/collections/${getCollection()}/points/payload`, {
    points: ids,
    payload,
  });
}

export async function qdrantGetPoints(ids: string[]): Promise<QdrantGetResult> {
  return qdrantReq<QdrantGetResult>("POST", `/collections/${getCollection()}/points`, {
    ids,
    with_payload: true,
  });
}
