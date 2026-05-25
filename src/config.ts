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
// without touching the real ~/.bikky/. The getter functions below re-read the
// env var on every call, so changing BIKKY_HOME at runtime (e.g. in a test
// setup hook) takes effect for all subsequent saveConfig()/loadConfig() calls.
//
// The legacy `BIKKY_DIR` / `CONFIG_PATH` / etc. exports are kept for
// backward-compatibility, but they capture the env state at module load
// time and should NOT be relied on for safe writes. Internal callers — and
// any test that wants sandboxing — should call the getter functions instead.

export function getBikkyDir(): string {
  return process.env.BIKKY_HOME ?? path.join(os.homedir(), ".bikky");
}
export function getConfigPath(): string {
  return path.join(getBikkyDir(), "config.json");
}
export function getLogDir(): string {
  return path.join(getBikkyDir(), "logs");
}
export function getStateDir(): string {
  return path.join(getBikkyDir(), "state");
}
export function getPidPath(): string {
  return path.join(getStateDir(), "daemon.pid");
}
export function getExtractionHealthPath(): string {
  return path.join(getStateDir(), "extraction-health.json");
}

// Legacy constant exports — captured at module load. Prefer the getter
// functions above when you need fresh values (e.g. inside tests, or after
// mutating BIKKY_HOME at runtime).
export const BIKKY_DIR = getBikkyDir();
export const CONFIG_PATH = getConfigPath();
export const LOG_DIR = getLogDir();
export const STATE_DIR = getStateDir();
export const PID_PATH = getPidPath();
export const EXTRACTION_HEALTH_PATH = getExtractionHealthPath();

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
  memory_quality_rollups_enabled: boolean;
  memory_quality_rollups_interval_sec: number;
  memory_quality_rollups_low_confidence_threshold: number;
  memory_quality_rollups_max_scopes_per_run: number;
  staleness_threshold_days: number;
}

export interface QdrantClientConfig {
  timeout_ms: number;
  retries: number;
  retry_base_delay_ms: number;
}

export interface IdentityConfig {
  user_id: string | null;
  user_name: string | null;
  /** @deprecated Use origin.user.id instead. */
  actor_id: string | null;
  /** @deprecated Use origin.user.name / origin.agent.name instead. */
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
  /** Human-readable guidance for LLMs/users about when to use this destination. */
  description?: string;
  qdrant_url: string;
  qdrant_api_key: string | null;
  collection: string;
  /** Marks this destination as the fallback when no rule matches. */
  default?: boolean;
  /** Routing rules. Omit for a destination that is only reachable by override. */
  match?: DestinationMatch;
}

export interface IgnoreRule {
  /** Stable identifier returned in ignored-write responses and logs. */
  name?: string;
  /** Human-readable reason/guidance for why the rule exists. */
  description?: string;
  /** Match rules using the same semantics as destination routing. */
  match: DestinationMatch;
}

export type SearchScopeTarget = "routed" | "all" | string | string[];

export interface SearchScopeDefinition {
  /** Stable scope name that MCP clients can pass as `search_scope`. */
  name: string;
  /** Guidance for LLMs/users about when this scope should be used. */
  description: string;
  /** Destination selector: "routed", "all", a destination name, or destination names. */
  destinations: SearchScopeTarget;
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
  /** Memory write exclusion rules. First matching rule skips persistence. */
  ignore: IgnoreRule[];
  /**
   * Default read/search scope. "routed" preserves historical behavior
   * (one destination via routing rules); "all" fans out to every destination;
   * a destination name or list searches only those destinations.
   */
  default_search_scope: SearchScopeTarget;
  /** Optional named search scopes exposed to MCP clients with descriptions. */
  search_scopes: SearchScopeDefinition[];
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
  ignore: [],
  default_search_scope: "routed",
  search_scopes: [],
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
    memory_quality_rollups_enabled: true,
    memory_quality_rollups_interval_sec: 3600,
    memory_quality_rollups_low_confidence_threshold: 0.6,
    memory_quality_rollups_max_scopes_per_run: 100,
    staleness_threshold_days: 30,
  },
  identity: {
    user_id: null,
    user_name: null,
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
  "PORTKEY_API_KEY",
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
  "BIKKY_DAEMON_MEMORY_QUALITY_ROLLUPS_ENABLED",
  "BIKKY_DAEMON_MEMORY_QUALITY_ROLLUPS_INTERVAL_SEC",
  "BIKKY_DAEMON_MEMORY_QUALITY_ROLLUPS_LOW_CONFIDENCE_THRESHOLD",
  "BIKKY_DAEMON_MEMORY_QUALITY_ROLLUPS_MAX_SCOPES_PER_RUN",
  "BIKKY_USER_ID",
  "BIKKY_USER_NAME",
  "BIKKY_AGENT_ID",
  "BIKKY_AGENT_NAME",
  "BIKKY_ACTOR_ID",
  "BIKKY_ACTOR_LABEL",
] as const;

const CONFIG_ENV_PREFIXES = [
  "BIKKY_EMBEDDING_EXTRA_",
  "BIKKY_LLM_EXTRA_",
] as const;

const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();
const stringRecord = z.record(z.string(), z.string());

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
  memory_quality_rollups_enabled: z.boolean().optional(),
  memory_quality_rollups_interval_sec: nonNegativeInt.optional(),
  memory_quality_rollups_low_confidence_threshold: z.number().min(0).max(1).optional(),
  memory_quality_rollups_max_scopes_per_run: positiveInt.optional(),
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
  user_id: z.string().nullable().optional(),
  user_name: z.string().nullable().optional(),
  actor_id: z.string().nullable().optional(),
  actor_label: z.string().nullable().optional(),
}).passthrough();

const regexArrayField = z.array(z.string()).optional();

const destinationMatchSchema = z.object({
  cwd: regexArrayField,
  entity: regexArrayField,
  content: regexArrayField,
  metadata: z.record(z.string(), z.array(z.string())).optional(),
}).passthrough();

const destinationFileSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  qdrant_url: z.string().min(1),
  qdrant_api_key: z.string().nullable().optional(),
  collection: z.string().min(1),
  default: z.boolean().optional(),
  match: destinationMatchSchema.optional(),
}).passthrough();

const ignoreRuleFileSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  match: destinationMatchSchema,
}).passthrough();

const searchScopeTargetSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

const searchScopeDefinitionFileSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  destinations: searchScopeTargetSchema,
}).passthrough();

const configFileSchema = z.object({
  qdrant_url: z.string().nullable().optional(),
  qdrant_api_key: z.string().nullable().optional(),
  collection: z.string().optional(),
  destinations: z.array(destinationFileSchema).optional(),
  ignore: z.array(ignoreRuleFileSchema).optional(),
  default_search_scope: searchScopeTargetSchema.optional(),
  search_scopes: z.array(searchScopeDefinitionFileSchema).optional(),
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

function issuePath(pathParts: PropertyKey[]): string {
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

function validateMatchBlock(match: Record<string, unknown>, base: string, issues: ConfigIssue[]): void {
  for (const field of ["cwd", "entity", "content"] as const) {
    const value = match[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      issues.push({ severity: "error", path: `${base}.${field}`, message: "must be an array of regex strings" });
      continue;
    }
    value.forEach((pattern, pIdx) => {
      if (typeof pattern !== "string") {
        issues.push({ severity: "error", path: `${base}.${field}[${pIdx}]`, message: "must be a string" });
        return;
      }
      try { new RegExp(pattern); }
      catch (e) {
        issues.push({
          severity: "error",
          path: `${base}.${field}[${pIdx}]`,
          message: `invalid regex: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    });
  }

  const metadata = childObject(match, "metadata");
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (!Array.isArray(value)) {
        issues.push({ severity: "error", path: `${base}.metadata.${key}`, message: "must be an array of regex strings" });
        continue;
      }
      value.forEach((pattern, pIdx) => {
        if (typeof pattern !== "string") {
          issues.push({ severity: "error", path: `${base}.metadata.${key}[${pIdx}]`, message: "must be a string" });
          return;
        }
        try { new RegExp(pattern); }
        catch (e) {
          issues.push({
            severity: "error",
            path: `${base}.metadata.${key}[${pIdx}]`,
            message: `invalid regex: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      });
    }
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
        validateMatchBlock(match, `${base}.match`, issues);
      }
    });
    if (defaultCount > 1) {
      issues.push({ severity: "error", path: "destinations", message: `at most one destination may set 'default: true' (found ${defaultCount})` });
    }
  }

  if (Array.isArray(raw.ignore)) {
    raw.ignore.forEach((entry, idx) => {
      const base = `ignore[${idx}]`;
      if (!isObject(entry)) {
        issues.push({ severity: "error", path: base, message: "must be an object" });
        return;
      }
      const match = entry.match;
      if (!isObject(match)) {
        issues.push({ severity: "error", path: `${base}.match`, message: "must be an object" });
        return;
      }
      validateMatchBlock(match, `${base}.match`, issues);
    });
  }

  const destinationNames = new Set<string>();
  if (Array.isArray(raw.destinations)) {
    for (const entry of raw.destinations) {
      if (isObject(entry) && typeof entry.name === "string" && entry.name.trim() !== "") {
        destinationNames.add(entry.name);
      }
    }
  }

  const searchScopeNames = new Set<string>();
  if (Array.isArray(raw.search_scopes)) {
    for (const entry of raw.search_scopes) {
      if (isObject(entry) && typeof entry.name === "string" && entry.name.trim() !== "") {
        searchScopeNames.add(entry.name);
      }
    }
  }

  const validateSearchScopeTarget = (target: unknown, pathName: string): void => {
    const values = Array.isArray(target) ? target : [target];
    for (const [idx, value] of values.entries()) {
      const valuePath = Array.isArray(target) ? `${pathName}[${idx}]` : pathName;
      if (typeof value !== "string" || value.trim() === "") continue;
      const normalized = value.trim();
      if (normalized === "all" || normalized === "routed" || destinationNames.size === 0) continue;
      if (searchScopeNames.has(normalized)) continue;
      if (!destinationNames.has(normalized)) {
        issues.push({
          severity: "warning",
          path: valuePath,
          message: `references unknown destination '${normalized}'`,
        });
      }
    }
  };

  if (Object.prototype.hasOwnProperty.call(raw, "default_search_scope")) {
    validateSearchScopeTarget(raw.default_search_scope, "default_search_scope");
  }

  if (Array.isArray(raw.search_scopes)) {
    const seenScopeNames = new Set<string>();
    raw.search_scopes.forEach((entry, idx) => {
      const base = `search_scopes[${idx}]`;
      if (!isObject(entry)) {
        issues.push({ severity: "error", path: base, message: "must be an object" });
        return;
      }
      const name = entry.name;
      if (typeof name === "string" && name.trim() !== "") {
        if (seenScopeNames.has(name)) {
          issues.push({ severity: "error", path: `${base}.name`, message: `duplicate search scope name '${name}'` });
        }
        seenScopeNames.add(name);
      }
      validateSearchScopeTarget(entry.destinations, `${base}.destinations`);
    });
  }

  const embedding = childObject(raw, "embedding");
  if (embedding) validateUrlLike(embedding.base_url, "embedding.base_url", issues);

  const llm = childObject(raw, "llm");
  if (llm) validateUrlLike(llm.base_url, "llm.base_url", issues);

  return issues;
}

export function inspectConfigFile(configPath = getConfigPath()): ConfigFileDiagnostics {
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
  fs.mkdirSync(getBikkyDir(), { recursive: true });
  fs.mkdirSync(getLogDir(), { recursive: true });
  fs.mkdirSync(getStateDir(), { recursive: true });

  // Start from defaults
  let config = structuredClone(DEFAULTS);

  // Merge config file
  const configPath = getConfigPath();
  let fileConfig: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      config = deepMerge(config as unknown as Record<string, unknown>, fileConfig) as unknown as BikkyConfig;
    } catch (e) {
      console.error(`bikky: failed to parse ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Provider/base_url consistency (issue #131): the DEFAULTS.embedding.base_url
  // is the ollama localhost URL, baked in for the default ollama provider. If
  // the user picks a different provider (portkey/openai/bedrock) but doesn't
  // set an explicit base_url, drop the inherited ollama URL so initEmbedding()
  // can apply the provider's own default — otherwise we'd POST every embedding
  // request to localhost:11434 and Ollama would reject the foreign model name.
  const fileEmbedding = (fileConfig.embedding ?? {}) as Record<string, unknown>;
  if (
    config.embedding.provider !== DEFAULTS.embedding.provider
    && typeof fileEmbedding.base_url !== "string"
    && !process.env.EMBEDDING_BASE_URL
  ) {
    config.embedding.base_url = "";
  }
  const fileLlm = (fileConfig.llm ?? {}) as Record<string, unknown>;
  if (
    config.llm.provider !== DEFAULTS.llm.provider
    && typeof fileLlm.base_url !== "string"
    && !process.env.LLM_BASE_URL
  ) {
    config.llm.base_url = "";
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
  // Portkey users can supply their gateway key via PORTKEY_API_KEY without
  // needing to repurpose OPENAI_API_KEY. Only applied when the embedding
  // provider is Portkey, so non-Portkey setups remain untouched.
  if (process.env.PORTKEY_API_KEY && config.embedding.provider === "portkey") {
    config.embedding.api_key = process.env.PORTKEY_API_KEY;
  }
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
  if (process.env.PORTKEY_API_KEY && config.llm.provider === "portkey" && !config.llm.api_key) {
    config.llm.api_key = process.env.PORTKEY_API_KEY;
  }
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
  const qualityRollupsEnabled = booleanEnv(process.env.BIKKY_DAEMON_MEMORY_QUALITY_ROLLUPS_ENABLED);
  if (qualityRollupsEnabled !== null) config.daemon.memory_quality_rollups_enabled = qualityRollupsEnabled;
  const qualityRollupsInterval = positiveInt(process.env.BIKKY_DAEMON_MEMORY_QUALITY_ROLLUPS_INTERVAL_SEC);
  if (qualityRollupsInterval !== null) config.daemon.memory_quality_rollups_interval_sec = qualityRollupsInterval;
  const qualityRollupsThresholdRaw = process.env.BIKKY_DAEMON_MEMORY_QUALITY_ROLLUPS_LOW_CONFIDENCE_THRESHOLD;
  if (qualityRollupsThresholdRaw) {
    const threshold = Number.parseFloat(qualityRollupsThresholdRaw);
    if (Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) {
      config.daemon.memory_quality_rollups_low_confidence_threshold = threshold;
    }
  }
  const qualityRollupsMaxScopes = positiveInt(process.env.BIKKY_DAEMON_MEMORY_QUALITY_ROLLUPS_MAX_SCOPES_PER_RUN);
  if (qualityRollupsMaxScopes !== null) config.daemon.memory_quality_rollups_max_scopes_per_run = qualityRollupsMaxScopes;
  if (process.env.BIKKY_USER_ID) config.identity.user_id = process.env.BIKKY_USER_ID;
  if (process.env.BIKKY_USER_NAME) config.identity.user_name = process.env.BIKKY_USER_NAME;
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
    description: "Default Qdrant destination synthesized from the top-level qdrant_url, qdrant_api_key, and collection settings.",
    qdrant_url: config.qdrant_url,
    qdrant_api_key: config.qdrant_api_key,
    collection: config.collection,
    default: true,
  }];
}

/** Save config to disk (used by setup command). */
export function saveConfig(config: BikkyConfig): void {
  fs.mkdirSync(getBikkyDir(), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
  _config = config;
}

/** Reset cached config (for testing). */
export function resetConfig(): void {
  _config = null;
}

export { DEFAULTS as CONFIG_DEFAULTS };
