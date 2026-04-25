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

export const portkeyInferenceProvider: InferenceProvider = {
  name: "portkey",
  label: "Portkey (gateway)",
  browserCompatible: false,
  defaults: {
    model: "@openai/gpt-4o-mini",
    baseUrl: "https://api.portkey.ai",
  },
  async chat(opts: ChatCompletionOpts, cfg: ResolvedInferenceConfig, log: LogFn): Promise<string | null> {
    if (!cfg.apiKey) { log("WARN", "LLM Portkey: no API key"); return null; }

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
      const resp = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.text().catch(() => "");
        log("WARN", `LLM Portkey error (${resp.status}): ${err.slice(0, 200)}`);
        return null;
      }
      const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (e: unknown) {
      log("WARN", `LLM Portkey error: ${(e as Error).message}`);
      return null;
    }
  },
};

registerInferenceProvider(portkeyInferenceProvider);
