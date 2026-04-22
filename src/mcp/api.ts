/**
 * External API helpers — Qdrant REST client, LLM chat, logging.
 * Credentials come from config (~/.bikky/config.json) or env vars.
 */

import fs from "node:fs";
import path from "node:path";
import type { QdrantFilter, QdrantGetResult, QdrantScrollResult, QdrantSearchResult } from "./types.js";
import { embed, getEmbeddingDimensions, getEmbeddingConfig, initEmbedding, chatCompletion, initLLM } from "../llm/index.js";
export type { EmbeddingProviderConfig } from "../llm/index.js";
export { embed, getEmbeddingDimensions, getEmbeddingConfig, initEmbedding };

import { createLogger } from "../logger.js";
import { BIKKY_DIR, LOG_DIR, loadConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const MEMORY_DIR = BIKKY_DIR;
let collectionName = "bikky";

export function getCollection(): string { return collectionName; }
export function setCollection(name: string): void { collectionName = name; }

fs.mkdirSync(MEMORY_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

let llmInitialized = false;

// ---------------------------------------------------------------------------
// Runtime state — populated at startup
// ---------------------------------------------------------------------------

export let qdrantUrl: string | null = null;
export let qdrantApiKey: string | null = null;
export let ready = false;

export function setQdrantUrl(v: string | null): void { qdrantUrl = v; }
export function setQdrantApiKey(v: string | null): void { qdrantApiKey = v; }
export function setReady(v: boolean): void { ready = v; }

// ---------------------------------------------------------------------------
// Logging (to file only — stdout/stderr are MCP stdio transport)
// ---------------------------------------------------------------------------

export const log = createLogger("memory-mcp", path.join(LOG_DIR, "mcp.log"), {
  maxSize: 2 * 1024 * 1024,
  maxFiles: 3,
});

// ---------------------------------------------------------------------------
// LLM Chat Completion (for distillation)
// ---------------------------------------------------------------------------

export async function chatComplete(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!llmInitialized) {
    const cfg = loadConfig();
    initLLM({
      config: {
        provider: cfg.llm.provider,
        ollama_url: cfg.llm.base_url,
        ollama_model: cfg.llm.model,
        openai_api_key: cfg.llm.api_key ?? null,
        openai_model: cfg.llm.model,
        bedrock_region: cfg.llm.bedrock_region,
        bedrock_model: cfg.llm.model,
      },
      logger: log as (...args: unknown[]) => void,
    });
    llmInitialized = true;
  }

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

// ---------------------------------------------------------------------------
// Qdrant REST Client
// ---------------------------------------------------------------------------

function qdrantHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "api-key": qdrantApiKey ?? "",
  };
}

export async function qdrantReq<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
  const url = `${qdrantUrl}${urlPath}`;
  const opts: RequestInit = { method, headers: qdrantHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Qdrant ${method} ${urlPath} failed (${resp.status}): ${text}`);
  }
  return resp.json() as Promise<T>;
}

export async function ensureCollection(indexes: Array<{ field_name: string; field_schema: string }>): Promise<void> {
  const col = getCollection();
  let exists = false;
  try {
    await qdrantReq<unknown>("GET", `/collections/${col}`);
    log("INFO", `Collection '${col}' exists ✓`);
    exists = true;
  } catch (e) {
    if (!(e instanceof Error && e.message.includes("404"))) throw e;
  }

  if (!exists) {
    await qdrantReq<unknown>("PUT", `/collections/${col}`, {
      vectors: { size: getEmbeddingDimensions(), distance: "Cosine" },
    });
    log("INFO", `Collection '${col}' created`);
  }

  for (const idx of indexes) {
    try {
      await qdrantReq<unknown>("PUT", `/collections/${col}/index`, idx);
    } catch (e) {
      log("WARN", `Index creation for ${idx.field_name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log("INFO", "Payload indexes created");
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
