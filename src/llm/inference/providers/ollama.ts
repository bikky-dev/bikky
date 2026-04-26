/**
 * Ollama chat-completion provider — POSTs to /v1/chat/completions (no auth).
 * JSON-schema response_format is downgraded to json_object since Ollama's
 * OpenAI-compatible endpoint does not implement schema enforcement.
 */

import type {
  InferenceProvider,
  ChatCompletionOpts,
  ResolvedInferenceConfig,
  LogFn,
} from "../types.js";
import { registerInferenceProvider } from "../registry.js";
import { resilientFetch } from "../../fetch.js";
import { LlmHttpError } from "../../errors.js";
import { _recordInferenceError } from "../index.js";

const RETRY_CAP_MS = 5_000;

export const ollamaInferenceProvider: InferenceProvider = {
  name: "ollama",
  label: "Ollama (local)",
  browserCompatible: false,
  defaults: {
    model: "qwen2.5:7b",
    baseUrl: "http://localhost:11434",
  },
  async chat(opts: ChatCompletionOpts, cfg: ResolvedInferenceConfig, log: LogFn): Promise<string | null> {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens ?? 500,
    };
    if (opts.response_format) {
      body.response_format = opts.response_format.type === "json_schema"
        ? { type: "json_object" }
        : opts.response_format;
    }

    try {
      const resp = await resilientFetch({
        url: `${cfg.baseUrl}/v1/chat/completions`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        timeoutMs: cfg.timeoutMs,
        retries: cfg.retries,
        baseDelayMs: cfg.retryBaseDelayMs,
        capDelayMs: RETRY_CAP_MS,
        provider: "ollama",
        model: cfg.model,
      });
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      _recordInferenceError(null);
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (e: unknown) {
      if (e instanceof LlmHttpError) {
        _recordInferenceError(e);
        log("WARN", `LLM Ollama ${e.kind}${e.status !== undefined ? ` (${e.status})` : ""}: ${e.message}`);
      } else {
        log("WARN", `LLM Ollama unreachable: ${(e as Error).message}`);
      }
      return null;
    }
  },
};

registerInferenceProvider(ollamaInferenceProvider);
