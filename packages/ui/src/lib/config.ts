/**
 * Config reader for @bikky/ui.
 * Reads BIKKY_HOME/config.json (or ~/.bikky/config.json) directly — no
 * dependency on the core bikky package.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function getBikkyDir(): string {
  return process.env.BIKKY_HOME ?? path.join(os.homedir(), ".bikky");
}
export function getConfigPath(): string {
  return path.join(getBikkyDir(), "config.json");
}

// Legacy constants — captured at module load. Prefer getBikkyDir()/getConfigPath()
// when sandboxing in tests or after mutating BIKKY_HOME at runtime.
export const BIKKY_DIR = getBikkyDir();
export const CONFIG_PATH = getConfigPath();

export interface UIDestination {
  name: string;
  qdrant_url: string;
  qdrant_api_key: string | null;
  collection: string;
  isDefault: boolean;
}

export interface BikkyUIConfig {
  qdrant_url: string | null;
  qdrant_api_key: string | null;
  collection: string;
  /** Parsed `destinations[]` from config (excluding match rules — UI doesn't route, it queries). */
  destinations: UIDestination[];
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
    base_url: string;
    api_key: string | null;
    extra?: Record<string, string>;
  };
  identity: {
    user_id: string | null;
    user_name: string | null;
  };
}

const DEFAULTS: BikkyUIConfig = {
  qdrant_url: null,
  qdrant_api_key: null,
  collection: "bikky",
  destinations: [],
  embedding: {
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    base_url: "http://localhost:11434",
    api_key: null,
    extra: {},
  },
  identity: {
    user_id: null,
    user_name: null,
  },
};

let _config: BikkyUIConfig | null = null;

export function loadConfig(): BikkyUIConfig {
  if (_config) return _config;

  let config = structuredClone(DEFAULTS);

  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      if (raw.qdrant_url) config.qdrant_url = raw.qdrant_url as string;
      if (raw.qdrant_api_key) config.qdrant_api_key = raw.qdrant_api_key as string;
      if (raw.collection) config.collection = raw.collection as string;
      if (Array.isArray(raw.destinations)) {
        config.destinations = (raw.destinations as Array<Record<string, unknown>>)
          .filter((d) => typeof d.name === "string" && typeof d.qdrant_url === "string")
          .map((d) => ({
            name: d.name as string,
            qdrant_url: (d.qdrant_url as string).replace(/\/+$/, ""),
            qdrant_api_key: typeof d.qdrant_api_key === "string" ? (d.qdrant_api_key as string) : null,
            collection: typeof d.collection === "string" ? (d.collection as string) : config.collection,
            isDefault: d.default === true,
          }));
      }
      if (raw.embedding && typeof raw.embedding === "object") {
        const emb = raw.embedding as Record<string, unknown>;
        if (emb.provider) config.embedding.provider = emb.provider as string;
        if (emb.model) config.embedding.model = emb.model as string;
        if (emb.dimensions) config.embedding.dimensions = emb.dimensions as number;
        if (emb.base_url) config.embedding.base_url = emb.base_url as string;
        if (emb.api_key) config.embedding.api_key = emb.api_key as string;
        if (emb.extra && typeof emb.extra === "object") config.embedding.extra = emb.extra as Record<string, string>;
      }
      if (raw.identity && typeof raw.identity === "object") {
        const identity = raw.identity as Record<string, unknown>;
        if (typeof identity.user_id === "string") config.identity.user_id = identity.user_id;
        if (typeof identity.user_name === "string") config.identity.user_name = identity.user_name;
      }
    } catch {
      console.error(`bikky-ui: failed to parse ${configPath}`);
    }
  }

  // Env overrides for legacy single-Qdrant config
  if (process.env.QDRANT_URL) config.qdrant_url = process.env.QDRANT_URL;
  if (process.env.QDRANT_API_KEY) config.qdrant_api_key = process.env.QDRANT_API_KEY;
  if (process.env.BIKKY_COLLECTION) config.collection = process.env.BIKKY_COLLECTION;
  if (process.env.EMBEDDING_PROVIDER) config.embedding.provider = process.env.EMBEDDING_PROVIDER;
  if (process.env.EMBEDDING_MODEL) config.embedding.model = process.env.EMBEDDING_MODEL;
  if (process.env.EMBEDDING_BASE_URL) config.embedding.base_url = process.env.EMBEDDING_BASE_URL;
  if (process.env.EMBEDDING_DIMENSIONS) {
    const n = parseInt(process.env.EMBEDDING_DIMENSIONS, 10);
    if (Number.isFinite(n) && n > 0) config.embedding.dimensions = n;
  }
  if (process.env.OPENAI_API_KEY) config.embedding.api_key = process.env.OPENAI_API_KEY;
  if (process.env.BIKKY_USER_ID) config.identity.user_id = process.env.BIKKY_USER_ID;
  if (process.env.BIKKY_USER_NAME) config.identity.user_name = process.env.BIKKY_USER_NAME;

  // Strip trailing slashes
  if (config.qdrant_url) config.qdrant_url = config.qdrant_url.replace(/\/+$/, "");
  config.embedding.base_url = config.embedding.base_url.replace(/\/+$/, "");

  _config = config;
  return config;
}

/**
 * Effective destinations list. If `destinations[]` is populated, return it.
 * Otherwise synthesize a single fallback destination from the legacy top-level
 * fields so single-Qdrant configs keep working.
 */
export function getEffectiveDestinations(): UIDestination[] {
  const cfg = loadConfig();
  if (cfg.destinations.length > 0) return cfg.destinations;
  if (!cfg.qdrant_url) return [];
  return [{
    name: "default",
    qdrant_url: cfg.qdrant_url,
    qdrant_api_key: cfg.qdrant_api_key,
    collection: cfg.collection,
    isDefault: true,
  }];
}

/** The destination used when no explicit `?destination=` is supplied. */
export function getDefaultDestination(): UIDestination | null {
  const dests = getEffectiveDestinations();
  if (dests.length === 0) return null;
  return dests.find((d) => d.isDefault) ?? dests[0]!;
}

/** Look up a destination by name. */
export function getDestinationByName(name: string): UIDestination | null {
  return getEffectiveDestinations().find((d) => d.name === name) ?? null;
}

/**
 * Test-only: clear the memoised config so the next loadConfig() call
 * re-reads the file and environment variables.
 */
export function _resetConfig(): void {
  _config = null;
}
