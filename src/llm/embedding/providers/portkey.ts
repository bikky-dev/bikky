/**
 * Portkey embedding provider — OpenAI-compatible gateway with provider routing.
 *
 * Portkey is a unified gateway: one endpoint, many underlying providers, with
 * routing/fallback/observability handled server-side. Configure the underlying
 * provider via either:
 *
 *   - extra.virtual_key  → server-side credential alias (recommended)
 *   - extra.config_id    → a saved Portkey config bundle
 *
 * Reference: https://portkey.ai/docs/api-reference/embeddings
 */

import { registerEmbeddingProvider } from "../registry.js";
import { resilientFetch } from "../../fetch.js";
import type { EmbeddingProvider, ResolvedEmbeddingConfig } from "../types.js";

interface PortkeyEmbedResponse {
  data: Array<{ embedding: number[] }>;
}

const RETRY_CAP_MS = 5_000;

export const portkeyEmbeddingProvider: EmbeddingProvider = {
  name: "portkey",
  label: "Portkey (gateway)",
  browserCompatible: true,
  defaults: {
    model: "@openai/text-embedding-3-small",
    dimensions: 1536,
    baseUrl: "https://api.portkey.ai",
  },
  async embed(text: string, cfg: ResolvedEmbeddingConfig): Promise<number[]> {
    if (!cfg.apiKey) throw new Error("Embedding failed [portkey]: api key not configured");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-portkey-api-key": cfg.apiKey,
    };
    if (cfg.extra.virtual_key) headers["x-portkey-virtual-key"] = cfg.extra.virtual_key;
    if (cfg.extra.config_id) headers["x-portkey-config"] = cfg.extra.config_id;

    const resp = await resilientFetch({
      url: `${cfg.baseUrl}/v1/embeddings`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg.model, input: text }),
      },
      timeoutMs: cfg.timeoutMs,
      retries: cfg.retries,
      baseDelayMs: cfg.retryBaseDelayMs,
      capDelayMs: RETRY_CAP_MS,
      provider: "portkey",
      model: cfg.model,
    });
    const data = (await resp.json()) as PortkeyEmbedResponse;
    const first = data.data[0];
    if (!first) throw new Error(`Embedding response from portkey missing data`);
    return first.embedding;
  },
};

registerEmbeddingProvider(portkeyEmbeddingProvider);
