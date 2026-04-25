/**
 * Public API for the inference (chat completion) layer.
 *
 * Importing this module registers all bundled providers via the side-effect
 * barrel, so callers only need to call `initLLM(...)` and `chatCompletion(...)`.
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

let resolved: ResolvedInferenceConfig | null = null;
let log: LogFn = () => {};

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
  };
  return resolved;
}

export function getInferenceConfig(): ResolvedInferenceConfig {
  if (!resolved) throw new Error("Inference provider not initialized — call initLLM() first");
  return resolved;
}

export async function chatCompletion(opts: ChatCompletionOpts): Promise<string | null> {
  const cfg = getInferenceConfig();
  const primary = getInferenceProvider(cfg.provider);
  const result = await primary.chat(opts, cfg, log);
  if (result !== null || !cfg.fallback) return result;

  log("INFO", `LLM: ${cfg.provider} returned null, falling back to ${cfg.fallback}`);
  const fallback = getInferenceProvider(cfg.fallback);
  // Reuse cfg.extra/apiKey since fallback may need different ones; callers can
  // supply them via the same `extra` bag for now. Future improvement: separate
  // fallback config block.
  const fallbackCfg: ResolvedInferenceConfig = {
    ...cfg,
    provider: fallback.name,
    model: fallback.defaults.model,
    baseUrl: fallback.defaults.baseUrl ?? "",
    fallback: null,
  };
  return fallback.chat(opts, fallbackCfg, log);
}

/** Test-only reset. */
export function _resetInference(): void {
  resolved = null;
  log = () => {};
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
