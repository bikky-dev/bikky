/**
 * Configuration loader for bikky.
 *
 * Resolution order: defaults → ~/.bikky/config.json → env vars.
 * Config directory: ~/.bikky/
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// BIKKY_HOME env var lets tests (and advanced users) override the config dir
// without touching the real ~/.bikky/. Tests MUST set this to an isolated
// tempdir before importing this module — otherwise saveConfig() will write to
// the user's real config file.
export const BIKKY_DIR = process.env.BIKKY_HOME ?? path.join(os.homedir(), ".bikky");
export const CONFIG_PATH = path.join(BIKKY_DIR, "config.json");
export const LOG_DIR = path.join(BIKKY_DIR, "logs");
export const STATE_DIR = path.join(BIKKY_DIR, "state");
export const PID_PATH = path.join(STATE_DIR, "daemon.pid");
export const EXTRACTION_HEALTH_PATH = path.join(STATE_DIR, "extraction-health.json");

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
  /** Per-request HTTP timeout. Defaults to 30s. */
  timeout_ms?: number;
  /** Max retries on transient/rate-limit/timeout failures. Defaults to 2. */
  retries?: number;
  /** Base backoff delay (ms) for retries. Defaults to 250ms. */
  retry_base_delay_ms?: number;
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
  /** Per-request HTTP timeout. Defaults to 30s. */
  timeout_ms?: number;
  /** Max retries on transient/rate-limit/timeout failures. Defaults to 2. */
  retries?: number;
  /** Base backoff delay (ms) for retries. Defaults to 250ms. */
  retry_base_delay_ms?: number;
}

export interface DaemonConfig {
  tick_interval_sec: number;
  extract_every_sec: number;
  extract_min_events: number;
  extraction_prompt: string | null;
  consolidation_enabled: boolean;
  relation_inference_enabled: boolean;
  relation_inference_interval_sec: number;
  relation_inference_max_pairs_per_run: number;
  entity_typing_enabled: boolean;
  entity_typing_interval_sec: number;
  entity_typing_max_entities_per_run: number;
  staleness_threshold_days: number;
}

export interface QdrantClientConfig {
  timeout_ms: number;
  retries: number;
  retry_base_delay_ms: number;
}

export interface IdentityConfig {
  actor_id: string | null;
  actor_label: string | null;
}

export interface WatcherConfig {
  copilot: { enabled: boolean; path: string };
  claude: { enabled: boolean; path: string };
}

/**
 * One Qdrant routing target. Each destination is fully self-contained: its own
 * URL, API key, collection name, and match rules. All fields in `match` are
 * arrays of regex strings; OR semantics within a destination's match block,
 * first-match-wins across destinations.
 */
export interface DestinationMatch {
  /** Match against `process.cwd()`. */
  cwd?: string[];
  /** Match against any of the input `entities`. */
  entity?: string[];
  /** Match against the input `content`. */
  content?: string[];
  /** Per-key match against the input `metadata`. */
  metadata?: Record<string, string[]>;
}

export interface Destination {
  /** Stable, unique name. Used as the `destination` override on tool calls. */
  name: string;
  qdrant_url: string;
  qdrant_api_key: string | null;
  collection: string;
  /** Marks this destination as the fallback when no rule matches. */
  default?: boolean;
  /** Routing rules. Omit for a destination that is only reachable by override. */
  match?: DestinationMatch;
}

export interface BikkyConfig {
  /**
   * Top-level Qdrant fields. When `destinations` is empty, a single default
   * destination is synthesized from these — keeps single-Qdrant configs
   * working without changes.
   */
  qdrant_url: string | null;
  qdrant_api_key: string | null;
  collection: string;
  /**
   * One or more Qdrant routing targets. Memory operations resolve to a
   * destination via override → cwd/entity/content/metadata regex match →
   * default flag → first entry.
   */
  destinations: Destination[];
  aws_profile: string | null;
  embedding: EmbeddingConfig;
  llm: LLMConfig;
  daemon: DaemonConfig;
  identity: IdentityConfig;
  watchers: WatcherConfig;
  qdrant_client: QdrantClientConfig;
}

export type ConfigIssueSeverity = "error" | "warning";

export interface ConfigIssue {
  severity: ConfigIssueSeverity;
  path: string;
  message: string;
}

export interface ConfigFileDiagnostics {
  path: string;
  exists: boolean;
  parse_error: string | null;
  issues: ConfigIssue[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: BikkyConfig = {
  qdrant_url: null,
  qdrant_api_key: null,
  collection: "bikky",
  destinations: [],
  aws_profile: null,
  embedding: {
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    base_url: "http://localhost:11434",
    api_key: null,
    extra: {},
    timeout_ms: 30_000,
    retries: 2,
    retry_base_delay_ms: 250,
  },
  llm: {
    provider: "ollama",
    model: "qwen2.5:7b",
    base_url: "http://localhost:11434",
    api_key: null,
    fallback_provider: null,
    extra: {},
    timeout_ms: 30_000,
    retries: 2,
    retry_base_delay_ms: 250,
  },
  daemon: {
    tick_interval_sec: 5,
    extract_every_sec: 300,
    extract_min_events: 10,
    extraction_prompt: null,
    consolidation_enabled: true,
    relation_inference_enabled: true,
    relation_inference_interval_sec: 7200,
    relation_inference_max_pairs_per_run: 3,
    entity_typing_enabled: true,
    entity_typing_interval_sec: 900,
    entity_typing_max_entities_per_run: 5,
    staleness_threshold_days: 30,
  },
  identity: {
    actor_id: null,
    actor_label: null,
  },
  watchers: {
    copilot: { enabled: true, path: path.join(os.homedir(), ".copilot", "session-state") },
    claude: { enabled: true, path: path.join(os.homedir(), ".claude", "projects") },
  },
  qdrant_client: {
    timeout_ms: 10_000,
    retries: 3,
    retry_base_delay_ms: 250,
  },
};

export const CONFIG_ENV_KEYS = [
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "BIKKY_COLLECTION",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_DIMENSIONS",
  "OPENAI_API_KEY",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_BASE_URL",
  "LLM_FALLBACK_PROVIDER",
  "AWS_PROFILE",
  "AWS_BEDROCK_REGION",
  "AWS_REGION",
  "QDRANT_TIMEOUT_MS",
  "QDRANT_RETRIES",
  "QDRANT_RETRY_BASE_DELAY_MS",
  "BIKKY_EMBEDDING_TIMEOUT_MS",
  "BIKKY_EMBEDDING_RETRIES",
  "BIKKY_EMBEDDING_RETRY_BASE_DELAY_MS",
  "BIKKY_LLM_TIMEOUT_MS",
  "BIKKY_LLM_RETRIES",
  "BIKKY_LLM_RETRY_BASE_DELAY_MS",
  "BIKKY_DAEMON_RELATION_INFERENCE_ENABLED",
  "BIKKY_DAEMON_RELATION_INFERENCE_INTERVAL_SEC",
  "BIKKY_DAEMON_RELATION_INFERENCE_MAX_PAIRS_PER_RUN",
  "BIKKY_DAEMON_ENTITY_TYPING_ENABLED",
  "BIKKY_DAEMON_ENTITY_TYPING_INTERVAL_SEC",
  "BIKKY_DAEMON_ENTITY_TYPING_MAX_ENTITIES_PER_RUN",
  "BIKKY_ACTOR_ID",
  "BIKKY_ACTOR_LABEL",
] as const;

const CONFIG_ENV_PREFIXES = [
  "BIKKY_EMBEDDING_EXTRA_",
  "BIKKY_LLM_EXTRA_",
] as const;

const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();
const stringRecord = z.record(z.string());

const embeddingConfigFileSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  dimensions: positiveInt.optional(),
  base_url: z.string().optional(),
  api_key: z.string().nullable().optional(),
  extra: stringRecord.optional(),
  timeout_ms: nonNegativeInt.optional(),
  retries: nonNegativeInt.optional(),
  retry_base_delay_ms: nonNegativeInt.optional(),
}).passthrough();

const llmConfigFileSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  base_url: z.string().optional(),
  api_key: z.string().nullable().optional(),
  fallback_provider: z.string().nullable().optional(),
  extra: stringRecord.optional(),
  timeout_ms: nonNegativeInt.optional(),
  retries: nonNegativeInt.optional(),
  retry_base_delay_ms: nonNegativeInt.optional(),
}).passthrough();

const daemonConfigFileSchema = z.object({
  tick_interval_sec: nonNegativeInt.optional(),
  extract_every_sec: nonNegativeInt.optional(),
  extract_min_events: nonNegativeInt.optional(),
  extraction_prompt: z.string().nullable().optional(),
  consolidation_enabled: z.boolean().optional(),
  relation_inference_enabled: z.boolean().optional(),
  relation_inference_interval_sec: nonNegativeInt.optional(),
  relation_inference_max_pairs_per_run: nonNegativeInt.optional(),
  entity_typing_enabled: z.boolean().optional(),
  entity_typing_interval_sec: nonNegativeInt.optional(),
  entity_typing_max_entities_per_run: nonNegativeInt.optional(),
  staleness_threshold_days: nonNegativeInt.optional(),
}).passthrough();

const watcherConfigFileSchema = z.object({
  copilot: z.object({
    enabled: z.boolean().optional(),
    path: z.string().optional(),
  }).passthrough().optional(),
  claude: z.object({
    enabled: z.boolean().optional(),
    path: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const qdrantClientConfigFileSchema = z.object({
  timeout_ms: nonNegativeInt.optional(),
  retries: nonNegativeInt.optional(),
  retry_base_delay_ms: nonNegativeInt.optional(),
}).passthrough();

const identityConfigFileSchema = z.object({
  actor_id: z.string().nullable().optional(),
  actor_label: z.string().nullable().optional(),
}).passthrough();

const regexArrayField = z.array(z.string()).optional();

const destinationMatchSchema = z.object({
  cwd: regexArrayField,
  entity: regexArrayField,
  content: regexArrayField,
  metadata: z.record(z.array(z.string())).optional(),
}).passthrough();

const destinationFileSchema = z.object({
  name: z.string().min(1),
  qdrant_url: z.string().min(1),
  qdrant_api_key: z.string().nullable().optional(),
  collection: z.string().min(1),
  default: z.boolean().optional(),
  match: destinationMatchSchema.optional(),
}).passthrough();

const configFileSchema = z.object({
  qdrant_url: z.string().nullable().optional(),
  qdrant_api_key: z.string().nullable().optional(),
  collection: z.string().optional(),
  destinations: z.array(destinationFileSchema).optional(),
  aws_profile: z.string().nullable().optional(),
  embedding: embeddingConfigFileSchema.optional(),
  llm: llmConfigFileSchema.optional(),
  daemon: daemonConfigFileSchema.optional(),
  identity: identityConfigFileSchema.optional(),
  watchers: watcherConfigFileSchema.optional(),
  qdrant_client: qdrantClientConfigFileSchema.optional(),
}).passthrough();

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

function issuePath(pathParts: Array<string | number>): string {
  return pathParts.length === 0 ? "$" : pathParts.map(String).join(".");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function childObject(raw: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = raw[key];
  return isObject(value) ? value : null;
}

function validateUrlLike(value: unknown, pathName: string, issues: ConfigIssue[]): void {
  if (typeof value !== "string" || value.trim() === "") return;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      issues.push({
        severity: "error",
        path: pathName,
        message: "must use http:// or https://",
      });
    }
  } catch {
    issues.push({
      severity: "error",
      path: pathName,
      message: "must be a valid URL",
    });
  }
}

export function validateConfigObject(raw: unknown): ConfigIssue[] {
  const parsed = configFileSchema.safeParse(raw);
  const issues: ConfigIssue[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        severity: "error",
        path: issuePath(issue.path),
        message: issue.message,
      });
    }
    if (!isObject(raw)) return issues;
  }

  if (!isObject(raw)) {
    issues.push({
      severity: "error",
      path: "$",
      message: "config file must contain a JSON object",
    });
    return issues;
  }

  if (typeof raw.collection === "string" && raw.collection.trim() === "") {
    issues.push({
      severity: "error",
      path: "collection",
      message: "must not be empty",
    });
  }

  validateUrlLike(raw.qdrant_url, "qdrant_url", issues);

  // Destinations validation
  if (Array.isArray(raw.destinations)) {
    const seenNames = new Set<string>();
    let defaultCount = 0;
    raw.destinations.forEach((entry, idx) => {
      const base = `destinations[${idx}]`;
      if (!isObject(entry)) {
        issues.push({ severity: "error", path: base, message: "must be an object" });
        return;
      }
      const name = entry.name;
      if (typeof name === "string" && name.trim() !== "") {
        if (seenNames.has(name)) {
          issues.push({ severity: "error", path: `${base}.name`, message: `duplicate destination name '${name}'` });
        }
        seenNames.add(name);
      }
      validateUrlLike(entry.qdrant_url, `${base}.qdrant_url`, issues);
      if (typeof entry.collection === "string" && entry.collection.trim() === "") {
        issues.push({ severity: "error", path: `${base}.collection`, message: "must not be empty" });
      }
      if (entry.default === true) defaultCount++;

      const match = childObject(entry, "match");
      if (match) {
        for (const field of ["cwd", "entity", "content"] as const) {
          const value = match[field];
          if (value === undefined) continue;
          if (!Array.isArray(value)) {
            issues.push({ severity: "error", path: `${base}.match.${field}`, message: "must be an array of regex strings" });
            continue;
          }
          value.forEach((pattern, pIdx) => {
            if (typeof pattern !== "string") {
              issues.push({ severity: "error", path: `${base}.match.${field}[${pIdx}]`, message: "must be a string" });
              return;
            }
            try { new RegExp(pattern); }
            catch (e) {
              issues.push({
                severity: "error",
                path: `${base}.match.${field}[${pIdx}]`,
                message: `invalid regex: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          });
        }
        const metadata = childObject(match, "metadata");
        if (metadata) {
          for (const [key, value] of Object.entries(metadata)) {
            if (!Array.isArray(value)) {
              issues.push({ severity: "error", path: `${base}.match.metadata.${key}`, message: "must be an array of regex strings" });
              continue;
            }
            value.forEach((pattern, pIdx) => {
              if (typeof pattern !== "string") {
                issues.push({ severity: "error", path: `${base}.match.metadata.${key}[${pIdx}]`, message: "must be a string" });
                return;
              }
              try { new RegExp(pattern); }
              catch (e) {
                issues.push({
                  severity: "error",
                  path: `${base}.match.metadata.${key}[${pIdx}]`,
                  message: `invalid regex: ${e instanceof Error ? e.message : String(e)}`,
                });
              }
            });
          }
        }
      }
    });
    if (defaultCount > 1) {
      issues.push({ severity: "error", path: "destinations", message: `at most one destination may set 'default: true' (found ${defaultCount})` });
    }
  }

  const embedding = childObject(raw, "embedding");
  if (embedding) validateUrlLike(embedding.base_url, "embedding.base_url", issues);

  const llm = childObject(raw, "llm");
  if (llm) validateUrlLike(llm.base_url, "llm.base_url", issues);

  return issues;
}

export function inspectConfigFile(configPath = CONFIG_PATH): ConfigFileDiagnostics {
  if (!fs.existsSync(configPath)) {
    return { path: configPath, exists: false, parse_error: null, issues: [] };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
    return {
      path: configPath,
      exists: true,
      parse_error: null,
      issues: validateConfigObject(raw),
    };
  } catch (e) {
    return {
      path: configPath,
      exists: true,
      parse_error: e instanceof Error ? e.message : String(e),
      issues: [{
        severity: "error",
        path: "$",
        message: e instanceof Error ? e.message : String(e),
      }],
    };
  }
}

export function getActiveConfigEnvOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  const active = new Set<string>();
  for (const key of CONFIG_ENV_KEYS) {
    if (env[key]) active.add(key);
  }
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (CONFIG_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) active.add(key);
  }
  return [...active].sort();
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
  if (process.env.EMBEDDING_DIMENSIONS) {
    const n = parseInt(process.env.EMBEDDING_DIMENSIONS, 10);
    if (Number.isFinite(n) && n > 0) config.embedding.dimensions = n;
  }
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

  // Embedding / LLM resilience tuning env overrides
  const positiveInt = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const embTimeout = positiveInt(process.env.BIKKY_EMBEDDING_TIMEOUT_MS);
  if (embTimeout !== null) config.embedding.timeout_ms = embTimeout;
  const embRetries = positiveInt(process.env.BIKKY_EMBEDDING_RETRIES);
  if (embRetries !== null) config.embedding.retries = embRetries;
  const embDelay = positiveInt(process.env.BIKKY_EMBEDDING_RETRY_BASE_DELAY_MS);
  if (embDelay !== null) config.embedding.retry_base_delay_ms = embDelay;
  const llmTimeout = positiveInt(process.env.BIKKY_LLM_TIMEOUT_MS);
  if (llmTimeout !== null) config.llm.timeout_ms = llmTimeout;
  const llmRetries = positiveInt(process.env.BIKKY_LLM_RETRIES);
  if (llmRetries !== null) config.llm.retries = llmRetries;
  const llmDelay = positiveInt(process.env.BIKKY_LLM_RETRY_BASE_DELAY_MS);
  if (llmDelay !== null) config.llm.retry_base_delay_ms = llmDelay;

  const booleanEnv = (raw: string | undefined): boolean | null => {
    if (!raw) return null;
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return null;
  };
  const relationEnabled = booleanEnv(process.env.BIKKY_DAEMON_RELATION_INFERENCE_ENABLED);
  if (relationEnabled !== null) config.daemon.relation_inference_enabled = relationEnabled;
  const relationInterval = positiveInt(process.env.BIKKY_DAEMON_RELATION_INFERENCE_INTERVAL_SEC);
  if (relationInterval !== null) config.daemon.relation_inference_interval_sec = relationInterval;
  const relationMax = positiveInt(process.env.BIKKY_DAEMON_RELATION_INFERENCE_MAX_PAIRS_PER_RUN);
  if (relationMax !== null) config.daemon.relation_inference_max_pairs_per_run = relationMax;
  const entityTypingEnabled = booleanEnv(process.env.BIKKY_DAEMON_ENTITY_TYPING_ENABLED);
  if (entityTypingEnabled !== null) config.daemon.entity_typing_enabled = entityTypingEnabled;
  const entityTypingInterval = positiveInt(process.env.BIKKY_DAEMON_ENTITY_TYPING_INTERVAL_SEC);
  if (entityTypingInterval !== null) config.daemon.entity_typing_interval_sec = entityTypingInterval;
  const entityTypingMax = positiveInt(process.env.BIKKY_DAEMON_ENTITY_TYPING_MAX_ENTITIES_PER_RUN);
  if (entityTypingMax !== null) config.daemon.entity_typing_max_entities_per_run = entityTypingMax;
  if (process.env.BIKKY_ACTOR_ID) config.identity.actor_id = process.env.BIKKY_ACTOR_ID;
  if (process.env.BIKKY_ACTOR_LABEL) config.identity.actor_label = process.env.BIKKY_ACTOR_LABEL;

  // Propagate aws_profile into env so both Bedrock clients (LLM + embedding)
  // pick it up via the SDK's default credential chain.
  if (config.aws_profile && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = config.aws_profile;
  }

  // Strip trailing slashes from URLs
  if (config.qdrant_url) config.qdrant_url = config.qdrant_url.replace(/\/+$/, "");
  config.embedding.base_url = config.embedding.base_url.replace(/\/+$/, "");
  config.llm.base_url = config.llm.base_url.replace(/\/+$/, "");
  for (const dest of config.destinations) {
    if (dest.qdrant_url) dest.qdrant_url = dest.qdrant_url.replace(/\/+$/, "");
  }

  _config = config;
  return config;
}

/**
 * Resolve the effective list of destinations from the loaded config.
 *
 * - If `destinations` is non-empty, return as-is.
 * - Otherwise synthesize a single fallback destination from the top-level
 *   `qdrant_url` / `qdrant_api_key` / `collection` so existing single-Qdrant
 *   configs keep working without changes.
 * - If neither is configured, returns an empty array — callers should treat
 *   that as "Qdrant not configured" the same way they did before.
 */
export function getEffectiveDestinations(config: BikkyConfig = loadConfig()): Destination[] {
  if (config.destinations.length > 0) return config.destinations;
  if (!config.qdrant_url) return [];
  return [{
    name: "default",
    qdrant_url: config.qdrant_url,
    qdrant_api_key: config.qdrant_api_key,
    collection: config.collection,
    default: true,
  }];
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
