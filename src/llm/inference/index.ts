/**
 * Public API for the inference (chat completion) layer.
 *
 * Importing this module registers all bundled providers via the side-effect
 * barrel, so callers only need to call `initLLM(...)` and `chatCompletion(...)`.
 *
 * Failure contract: provider `chat()` returns `null` on any failure (auth,
 * rate-limit, transient, timeout). The reason is recorded internally; callers
 * that need to surface it to the user can call `getLastInferenceError()`. The
 * fallback chain in `chatCompletion()` retries the secondary provider once,
 * then logs a consolidated error covering both attempts.
 */

import "./providers/index.js";

import {
  getInferenceProvider,
  listInferenceProviders,
  registerInferenceProvider,
} from "./registry.js";
import type {
  ChatCompletionOpts,
  ChatCompletionUsage,
  InferenceProvider,
  InitLLMInput,
  LogFn,
  ResolvedInferenceConfig,
} from "./types.js";
import type { LlmHttpError } from "../errors.js";
import { firstNonEmptyString } from "../util.js";
import { estimateTokens, writeTelemetry } from "../telemetry.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;

let resolved: ResolvedInferenceConfig | null = null;
let log: LogFn = () => {};
let lastError: LlmHttpError | null = null;
let lastUsage: ChatCompletionUsage | null = null;

export function initLLM(opts: { config: InitLLMInput; logger?: LogFn }): ResolvedInferenceConfig {
  const provider = getInferenceProvider(opts.config.provider);
  if (opts.logger) log = opts.logger;
  resolved = {
    provider: provider.name,
    model: opts.config.model ?? provider.defaults.model,
    baseUrl: (firstNonEmptyString(opts.config.baseUrl, provider.defaults.baseUrl) ?? "").replace(/\/+$/, ""),
    apiKey: opts.config.apiKey ?? null,
    fallback: opts.config.fallback ?? null,
    extra: opts.config.extra ?? {},
    timeoutMs: opts.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: opts.config.retries ?? DEFAULT_RETRIES,
    retryBaseDelayMs: opts.config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
  };
  lastError = null;
  return resolved;
}

export function getInferenceConfig(): ResolvedInferenceConfig {
  if (!resolved) throw new Error("Inference provider not initialized — call initLLM() first");
  return resolved;
}

/**
 * The most-recent classified error from the inference layer, or null if the
 * last call succeeded. Used by MCP tools to surface a meaningful reason when
 * `chatCompletion()` returns null.
 */
export function getLastInferenceError(): LlmHttpError | null {
  return lastError;
}

/**
 * Internal hook used by providers to record the typed reason for a `null`
 * return. Exported so providers in `./providers/*` can reach it; not part of
 * the public API.
 */
export function _recordInferenceError(err: LlmHttpError | null): void {
  lastError = err;
}

export function _recordInferenceUsage(usage: ChatCompletionUsage | null): void {
  lastUsage = usage;
}

export async function chatCompletion(opts: ChatCompletionOpts): Promise<string | null> {
  const cfg = getInferenceConfig();
  lastError = null;
  const primary = getInferenceProvider(cfg.provider);
  const result = await callProviderWithTelemetry(primary, opts, cfg);
  if (result !== null) return result;
  const primaryErr = getLastInferenceError();

  if (!cfg.fallback) {
    if (primaryErr) {
      log("ERROR", `LLM ${cfg.provider} failed (${primaryErr.kind}): ${primaryErr.message}`);
    }
    return null;
  }

  log("INFO", `LLM: ${cfg.provider} returned null${primaryErr ? ` (${primaryErr.kind})` : ""}, falling back to ${cfg.fallback}`);
  const fallback = getInferenceProvider(cfg.fallback);
  const fallbackCfg: ResolvedInferenceConfig = {
    ...cfg,
    provider: fallback.name,
    model: fallback.defaults.model,
    baseUrl: fallback.defaults.baseUrl ?? "",
    fallback: null,
  };
  lastError = null;
  const fbResult = await callProviderWithTelemetry(fallback, opts, fallbackCfg);
  if (fbResult !== null) return fbResult;

  const fallbackErr = getLastInferenceError();
  log(
    "ERROR",
    `LLM both providers failed — primary[${cfg.provider}]: ${primaryErr ? `${primaryErr.kind}: ${primaryErr.message}` : "unknown"} | ` +
      `fallback[${cfg.fallback}]: ${fallbackErr ? `${fallbackErr.kind}: ${fallbackErr.message}` : "unknown"}`,
  );
  // Preserve the most actionable error (prefer auth/bad_request over transient).
  lastError = pickMoreActionable(primaryErr, fallbackErr);
  return null;
}

/** Test-only reset. */
export function _resetInference(): void {
  resolved = null;
  log = () => {};
  lastError = null;
  lastUsage = null;
}

async function callProviderWithTelemetry(
  provider: InferenceProvider,
  opts: ChatCompletionOpts,
  cfg: ResolvedInferenceConfig,
): Promise<string | null> {
  lastUsage = null;
  const startedAt = Date.now();
  const result = await provider.chat(opts, cfg, log);
  const latencyMs = Date.now() - startedAt;
  const err = result === null ? getLastInferenceError() : null;
  const usage = lastUsage as ChatCompletionUsage | null;
  const promptText = opts.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");

  await writeTelemetry({
    ts: new Date().toISOString(),
    prompt: opts.promptName ?? "unknown",
    model: cfg.model,
    provider: provider.name,
    ...(opts.telemetry?.subsystem ? { subsystem: opts.telemetry.subsystem } : {}),
    ...(opts.telemetry?.session_id ? { session_id: opts.telemetry.session_id } : {}),
    ...(opts.telemetry?.workstream_key ? { workstream_key: opts.telemetry.workstream_key } : {}),
    ...(opts.telemetry?.trigger ? { trigger: opts.telemetry.trigger } : {}),
    ok: result !== null,
    latency_ms: latencyMs,
    tokens_in_est: estimateTokens(promptText),
    tokens_out_est: estimateTokens(result ?? ""),
    ...(usage?.input_tokens != null ? { tokens_in_actual: usage.input_tokens } : {}),
    ...(usage?.output_tokens != null ? { tokens_out_actual: usage.output_tokens } : {}),
    ...(usage?.total_tokens != null ? { tokens_total_actual: usage.total_tokens } : {}),
    ...(err ? { error: `${err.kind}: ${err.message}` } : {}),
    ...(usage?.request_id ? { request_id: usage.request_id } : {}),
  }, log);

  return result;
}

function pickMoreActionable(a: LlmHttpError | null, b: LlmHttpError | null): LlmHttpError | null {
  if (!a) return b;
  if (!b) return a;
  const order = (k: string): number => {
    switch (k) {
      case "auth": return 0;
      case "bad_request": return 1;
      case "rate_limit": return 2;
      case "timeout": return 3;
      case "transient": return 4;
      default: return 5;
    }
  };
  return order(a.kind) <= order(b.kind) ? a : b;
}

export {
  registerInferenceProvider,
  getInferenceProvider,
  listInferenceProviders,
};
export type {
  InferenceProvider,
  ChatCompletionOpts,
  ResolvedInferenceConfig,
  InitLLMInput,
};
