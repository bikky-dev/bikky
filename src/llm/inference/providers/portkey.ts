/**
 * Portkey gateway chat-completion provider.
 *
 * Portkey speaks the OpenAI chat-completions wire format with extra headers.
 * Auth: `x-portkey-api-key`. Optional routing: `x-portkey-virtual-key` and/or
 * `x-portkey-config` from cfg.extra.virtual_key / cfg.extra.config_id.
 *
 * Default model is namespaced (e.g. "@openai/gpt-4o-mini"); pass-through any
 * provider/model the user prefers.
 */

import type {
  InferenceProvider,
  ChatCompletionOpts,
  ResolvedInferenceConfig,
  LogFn,
} from "../types.js";
import { registerInferenceProvider } from "../registry.js";
import { resilientFetch } from "../../fetch.js";
import {
  LlmAuthError,
  LlmHttpError,
  type LlmErrorDetails,
} from "../../errors.js";
import { _recordInferenceError, _recordInferenceUsage } from "../index.js";

const RETRY_CAP_MS = 5_000;

export const portkeyInferenceProvider: InferenceProvider = {
  name: "portkey",
  label: "Portkey (gateway)",
  browserCompatible: false,
  defaults: {
    model: "@openai/gpt-4o-mini",
    baseUrl: "https://api.portkey.ai",
  },
  async chat(opts: ChatCompletionOpts, cfg: ResolvedInferenceConfig, log: LogFn): Promise<string | null> {
    if (!cfg.apiKey) {
      const details: LlmErrorDetails = { provider: "portkey", model: cfg.model, body: "no API key" };
      const err = new LlmAuthError(details);
      _recordInferenceError(err);
      log("WARN", `LLM Portkey: no API key`);
      return null;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-portkey-api-key": cfg.apiKey,
    };
    if (cfg.extra.virtual_key) headers["x-portkey-virtual-key"] = cfg.extra.virtual_key;
    if (cfg.extra.config_id) headers["x-portkey-config"] = cfg.extra.config_id;

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens ?? 500,
    };
    if (opts.response_format) body.response_format = opts.response_format;

    try {
      const resp = await resilientFetch({
        url: `${cfg.baseUrl}/v1/chat/completions`,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        timeoutMs: cfg.timeoutMs,
        retries: cfg.retries,
        baseDelayMs: cfg.retryBaseDelayMs,
        capDelayMs: RETRY_CAP_MS,
        provider: "portkey",
        model: cfg.model,
      });
      const data = (await resp.json()) as {
        id?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      _recordInferenceError(null);
      _recordInferenceUsage({
        input_tokens: data.usage?.prompt_tokens,
        output_tokens: data.usage?.completion_tokens,
        total_tokens: data.usage?.total_tokens,
        request_id: data.id,
      });
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (e: unknown) {
      if (e instanceof LlmHttpError) {
        _recordInferenceError(e);
        log("WARN", `LLM Portkey ${e.kind}${e.status !== undefined ? ` (${e.status})` : ""}: ${e.message}`);
      } else {
        log("WARN", `LLM Portkey error: ${(e as Error).message}`);
      }
      return null;
    }
  },
};

registerInferenceProvider(portkeyInferenceProvider);
