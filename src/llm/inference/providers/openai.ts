/**
 * OpenAI chat-completion provider — POSTs to /v1/chat/completions with bearer
 * auth. Forwards `response_format` (json_object or json_schema) as-is.
 *
 * On failure: catches typed errors from the resilient fetch helper, records
 * them via `_recordInferenceError` for surfacing by the orchestrator, and
 * returns `null` to keep the fallback contract.
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

export const openaiInferenceProvider: InferenceProvider = {
  name: "openai",
  label: "OpenAI",
  browserCompatible: false,
  defaults: {
    model: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com",
  },
  async chat(opts: ChatCompletionOpts, cfg: ResolvedInferenceConfig, log: LogFn): Promise<string | null> {
    if (!cfg.apiKey) {
      const details: LlmErrorDetails = { provider: "openai", model: cfg.model, body: "no API key" };
      const err = new LlmAuthError(details);
      _recordInferenceError(err);
      log("WARN", `LLM OpenAI: no API key`);
      return null;
    }

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
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
        },
        timeoutMs: cfg.timeoutMs,
        retries: cfg.retries,
        baseDelayMs: cfg.retryBaseDelayMs,
        capDelayMs: RETRY_CAP_MS,
        provider: "openai",
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
        log("WARN", `LLM OpenAI ${e.kind}${e.status !== undefined ? ` (${e.status})` : ""}: ${e.message}`);
      } else {
        log("WARN", `LLM OpenAI error: ${(e as Error).message}`);
      }
      return null;
    }
  },
};

registerInferenceProvider(openaiInferenceProvider);
