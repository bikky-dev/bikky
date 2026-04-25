/**
 * Config reader for @bikky/ui.
 * Reads ~/.bikky/config.json directly — no dependency on core bikky package.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const BIKKY_DIR = path.join(os.homedir(), ".bikky");
export const CONFIG_PATH = path.join(BIKKY_DIR, "config.json");

export interface BikkyUIConfig {
  qdrant_url: string | null;
  qdrant_api_key: string | null;
  collection: string;
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
    base_url: string;
    api_key: string | null;
    extra?: Record<string, string>;
  };
}

const DEFAULTS: BikkyUIConfig = {
  qdrant_url: null,
  qdrant_api_key: null,
  collection: "bikky",
  embedding: {
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    base_url: "http://localhost:11434",
    api_key: null,
    extra: {},
  },
};

let _config: BikkyUIConfig | null = null;

export function loadConfig(): BikkyUIConfig {
  if (_config) return _config;

  let config = structuredClone(DEFAULTS);

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
      if (raw.qdrant_url) config.qdrant_url = raw.qdrant_url as string;
      if (raw.qdrant_api_key) config.qdrant_api_key = raw.qdrant_api_key as string;
      if (raw.collection) config.collection = raw.collection as string;
      if (raw.embedding && typeof raw.embedding === "object") {
        const emb = raw.embedding as Record<string, unknown>;
        if (emb.provider) config.embedding.provider = emb.provider as string;
        if (emb.model) config.embedding.model = emb.model as string;
        if (emb.dimensions) config.embedding.dimensions = emb.dimensions as number;
        if (emb.base_url) config.embedding.base_url = emb.base_url as string;
        if (emb.api_key) config.embedding.api_key = emb.api_key as string;
        if (emb.extra && typeof emb.extra === "object") config.embedding.extra = emb.extra as Record<string, string>;
      }
    } catch {
      console.error(`bikky-ui: failed to parse ${CONFIG_PATH}`);
    }
  }

  // Env overrides
  if (process.env.QDRANT_URL) config.qdrant_url = process.env.QDRANT_URL;
  if (process.env.QDRANT_API_KEY) config.qdrant_api_key = process.env.QDRANT_API_KEY;
  if (process.env.BIKKY_COLLECTION) config.collection = process.env.BIKKY_COLLECTION;
  if (process.env.EMBEDDING_PROVIDER) config.embedding.provider = process.env.EMBEDDING_PROVIDER;
  if (process.env.EMBEDDING_MODEL) config.embedding.model = process.env.EMBEDDING_MODEL;
  if (process.env.EMBEDDING_BASE_URL) config.embedding.base_url = process.env.EMBEDDING_BASE_URL;
  if (process.env.OPENAI_API_KEY) config.embedding.api_key = process.env.OPENAI_API_KEY;

  // Strip trailing slashes
  if (config.qdrant_url) config.qdrant_url = config.qdrant_url.replace(/\/+$/, "");
  config.embedding.base_url = config.embedding.base_url.replace(/\/+$/, "");

  _config = config;
  return config;
}

/**
 * Test-only: clear the memoised config so the next loadConfig() call
 * re-reads the file and environment variables.
 */
export function _resetConfig(): void {
  _config = null;
}
