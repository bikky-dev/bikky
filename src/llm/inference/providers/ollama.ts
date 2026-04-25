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
      const resp = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        log("WARN", `LLM Ollama error (${resp.status}): ${err.slice(0, 200)}`);
        return null;
      }
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (e: unknown) {
      log("WARN", `LLM Ollama unreachable: ${(e as Error).message}`);
      return null;
    }
  },
};

registerInferenceProvider(ollamaInferenceProvider);
