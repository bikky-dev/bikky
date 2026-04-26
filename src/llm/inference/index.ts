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
  InferenceProvider,
  InitLLMInput,
  LogFn,
  ResolvedInferenceConfig,
} from "./types.js";
import { LlmHttpError } from "../errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;

let resolved: ResolvedInferenceConfig | null = null;
let log: LogFn = () => {};
let lastError: LlmHttpError | null = null;

export function initLLM(opts: { config: InitLLMInput; logger?: LogFn }): ResolvedInferenceConfig {
  const provider = getInferenceProvider(opts.config.provider);
  if (opts.logger) log = opts.logger;
  resolved = {
    provider: provider.name,
    model: opts.config.model ?? provider.defaults.model,
    baseUrl: (opts.config.baseUrl ?? provider.defaults.baseUrl ?? "").replace(/\/+$/, ""),
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

export async function chatCompletion(opts: ChatCompletionOpts): Promise<string | null> {
  const cfg = getInferenceConfig();
  lastError = null;
  const primary = getInferenceProvider(cfg.provider);
  const result = await primary.chat(opts, cfg, log);
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
  const fbResult = await fallback.chat(opts, fallbackCfg, log);
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
