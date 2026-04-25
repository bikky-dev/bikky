/**
 * OpenAI chat-completion provider — POSTs to /v1/chat/completions with bearer
 * auth. Forwards `response_format` (json_object or json_schema) as-is.
 */

import type {
  InferenceProvider,
  ChatCompletionOpts,
  ResolvedInferenceConfig,
  LogFn,
} from "../types.js";
import { registerInferenceProvider } from "../registry.js";

export const openaiInferenceProvider: InferenceProvider = {
  name: "openai",
  label: "OpenAI",
  browserCompatible: false,
  defaults: {
    model: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com",
  },
  async chat(opts: ChatCompletionOpts, cfg: ResolvedInferenceConfig, log: LogFn): Promise<string | null> {
    if (!cfg.apiKey) { log("WARN", "LLM OpenAI: no API key"); return null; }

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens ?? 500,
    };
    if (opts.response_format) body.response_format = opts.response_format;

    try {
      const resp = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        log("WARN", `LLM OpenAI error (${resp.status}): ${err.slice(0, 200)}`);
        return null;
      }
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (e: unknown) {
      log("WARN", `LLM OpenAI error: ${(e as Error).message}`);
      return null;
    }
  },
};

registerInferenceProvider(openaiInferenceProvider);
