/**
 * Configuration loader for bikky.
 *
 * Resolution order: defaults → ~/.bikky/config.json → env vars.
 * Config directory: ~/.bikky/
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const BIKKY_DIR = path.join(os.homedir(), ".bikky");
export const CONFIG_PATH = path.join(BIKKY_DIR, "config.json");
export const LOG_DIR = path.join(BIKKY_DIR, "logs");
export const STATE_DIR = path.join(BIKKY_DIR, "state");
export const PID_PATH = path.join(STATE_DIR, "daemon.pid");

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface EmbeddingConfig {
  /** Provider name as registered in the embedding registry. */
  provider: string;
  model: string;
  dimensions: number;
  base_url: string;
  api_key: string | null;
  /** Provider-specific extras (e.g. portkey virtual_key, bedrock region). */
  extra?: Record<string, string>;
}

export interface LLMConfig {
  /** Provider name as registered in the inference registry. */
  provider: string;
  model: string;
  base_url: string;
  api_key: string | null;
  /** Optional fallback provider name. */
  fallback_provider?: string | null;
  /** Provider-specific extras. */
  extra?: Record<string, string>;
}

export interface DaemonConfig {
  tick_interval_sec: number;
  extract_every_sec: number;
  extract_min_events: number;
  extraction_prompt: string | null;
  consolidation_enabled: boolean;
  relation_inference_enabled: boolean;
  staleness_threshold_days: number;
}

export interface QdrantClientConfig {
  timeout_ms: number;
  retries: number;
  retry_base_delay_ms: number;
}

export interface WatcherConfig {
  copilot: { enabled: boolean; path: string };
  claude: { enabled: boolean; path: string };
}

export interface BikkyConfig {
  qdrant_url: string | null;
  qdrant_api_key: string | null;
  collection: string;
  aws_profile: string | null;
  embedding: EmbeddingConfig;
  llm: LLMConfig;
  daemon: DaemonConfig;
  watchers: WatcherConfig;
  qdrant_client: QdrantClientConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: BikkyConfig = {
  qdrant_url: null,
  qdrant_api_key: null,
  collection: "bikky",
  aws_profile: null,
  embedding: {
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    base_url: "http://localhost:11434",
    api_key: null,
    extra: {},
  },
  llm: {
    provider: "ollama",
    model: "qwen2.5:7b",
    base_url: "http://localhost:11434",
    api_key: null,
    fallback_provider: null,
    extra: {},
  },
  daemon: {
    tick_interval_sec: 5,
    extract_every_sec: 300,
    extract_min_events: 10,
    extraction_prompt: null,
    consolidation_enabled: true,
    relation_inference_enabled: true,
    staleness_threshold_days: 30,
  },
  watchers: {
    copilot: { enabled: true, path: path.join(os.homedir(), ".copilot", "session-state") },
    claude: { enabled: false, path: path.join(os.homedir(), ".claude", "projects") },
  },
  qdrant_client: {
    timeout_ms: 10_000,
    retries: 3,
    retry_base_delay_ms: 250,
  },
};

// ---------------------------------------------------------------------------
// Deep merge utility
// ---------------------------------------------------------------------------

function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const bVal = (base as Record<string, unknown>)[key];
    const oVal = override[key];
    if (bVal && typeof bVal === "object" && !Array.isArray(bVal) && oVal && typeof oVal === "object" && !Array.isArray(oVal)) {
      (result as Record<string, unknown>)[key] = deepMerge(bVal as Record<string, unknown>, oVal as Record<string, unknown>);
    } else if (oVal !== undefined) {
      (result as Record<string, unknown>)[key] = oVal;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

let _config: BikkyConfig | null = null;

export function loadConfig(): BikkyConfig {
  if (_config) return _config;

  // Ensure dirs exist
  fs.mkdirSync(BIKKY_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // Start from defaults
  let config = structuredClone(DEFAULTS);

  // Merge config file
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
      config = deepMerge(config as unknown as Record<string, unknown>, fileConfig) as unknown as BikkyConfig;
    } catch (e) {
      console.error(`bikky: failed to parse ${CONFIG_PATH}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Env var overrides (highest priority)
  if (process.env.QDRANT_URL) config.qdrant_url = process.env.QDRANT_URL;
  if (process.env.QDRANT_API_KEY) config.qdrant_api_key = process.env.QDRANT_API_KEY;
  if (process.env.BIKKY_COLLECTION) config.collection = process.env.BIKKY_COLLECTION;

  // Embedding env overrides
  if (process.env.EMBEDDING_PROVIDER) config.embedding.provider = process.env.EMBEDDING_PROVIDER;
  if (process.env.EMBEDDING_MODEL) config.embedding.model = process.env.EMBEDDING_MODEL;
  if (process.env.EMBEDDING_BASE_URL) config.embedding.base_url = process.env.EMBEDDING_BASE_URL;
  if (process.env.EMBEDDING_DIMENSIONS) config.embedding.dimensions = parseInt(process.env.EMBEDDING_DIMENSIONS, 10);
  if (process.env.OPENAI_API_KEY) config.embedding.api_key = process.env.OPENAI_API_KEY;
  // Generic provider-extras: BIKKY_EMBEDDING_EXTRA_<KEY>=value
  config.embedding.extra = config.embedding.extra ?? {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("BIKKY_EMBEDDING_EXTRA_") && typeof v === "string") {
      config.embedding.extra[k.slice("BIKKY_EMBEDDING_EXTRA_".length).toLowerCase()] = v;
    }
  }

  // LLM env overrides
  if (process.env.LLM_PROVIDER) config.llm.provider = process.env.LLM_PROVIDER;
  if (process.env.LLM_MODEL) config.llm.model = process.env.LLM_MODEL;
  if (process.env.LLM_BASE_URL) config.llm.base_url = process.env.LLM_BASE_URL;
  if (process.env.OPENAI_API_KEY && !config.llm.api_key) config.llm.api_key = process.env.OPENAI_API_KEY;
  if (process.env.LLM_FALLBACK_PROVIDER) config.llm.fallback_provider = process.env.LLM_FALLBACK_PROVIDER;
  if (process.env.AWS_PROFILE) config.aws_profile = process.env.AWS_PROFILE;
  // Generic provider-extras: BIKKY_LLM_EXTRA_<KEY>=value
  config.llm.extra = config.llm.extra ?? {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("BIKKY_LLM_EXTRA_") && typeof v === "string") {
      config.llm.extra[k.slice("BIKKY_LLM_EXTRA_".length).toLowerCase()] = v;
    }
  }
  // Convenience: forward AWS_BEDROCK_REGION / AWS_REGION into llm.extra.region
  // and embedding.extra.region so the bedrock providers find them without
  // requiring users to set BIKKY_LLM_EXTRA_REGION explicitly.
  const awsRegion = process.env.AWS_BEDROCK_REGION ?? process.env.AWS_REGION;
  if (awsRegion) {
    if (!config.llm.extra.region) config.llm.extra.region = awsRegion;
    if (!config.embedding.extra.region) config.embedding.extra.region = awsRegion;
  }

  // Qdrant client tuning env overrides
  if (process.env.QDRANT_TIMEOUT_MS) {
    const n = parseInt(process.env.QDRANT_TIMEOUT_MS, 10);
    if (Number.isFinite(n) && n >= 0) config.qdrant_client.timeout_ms = n;
  }
  if (process.env.QDRANT_RETRIES) {
    const n = parseInt(process.env.QDRANT_RETRIES, 10);
    if (Number.isFinite(n) && n >= 0) config.qdrant_client.retries = n;
  }
  if (process.env.QDRANT_RETRY_BASE_DELAY_MS) {
    const n = parseInt(process.env.QDRANT_RETRY_BASE_DELAY_MS, 10);
    if (Number.isFinite(n) && n >= 0) config.qdrant_client.retry_base_delay_ms = n;
  }

  // Propagate aws_profile into env so both Bedrock clients (LLM + embedding)
  // pick it up via the SDK's default credential chain.
  if (config.aws_profile && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = config.aws_profile;
  }

  // Strip trailing slashes from URLs
  if (config.qdrant_url) config.qdrant_url = config.qdrant_url.replace(/\/+$/, "");
  config.embedding.base_url = config.embedding.base_url.replace(/\/+$/, "");
  config.llm.base_url = config.llm.base_url.replace(/\/+$/, "");

  _config = config;
  return config;
}

/** Save config to disk (used by setup command). */
export function saveConfig(config: BikkyConfig): void {
  fs.mkdirSync(BIKKY_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  _config = config;
}

/** Reset cached config (for testing). */
export function resetConfig(): void {
  _config = null;
}

export { DEFAULTS as CONFIG_DEFAULTS };
