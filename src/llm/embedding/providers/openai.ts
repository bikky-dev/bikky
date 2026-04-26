/**
 * OpenAI embedding provider — /v1/embeddings with bearer auth.
 */

import { registerEmbeddingProvider } from "../registry.js";
import { resilientFetch } from "../../fetch.js";
import type { EmbeddingProvider, ResolvedEmbeddingConfig } from "../types.js";

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[] }>;
}

const RETRY_CAP_MS = 5_000;

export const openaiEmbeddingProvider: EmbeddingProvider = {
  name: "openai",
  label: "OpenAI",
  browserCompatible: true,
  defaults: {
    model: "text-embedding-3-small",
    dimensions: 1536,
    baseUrl: "https://api.openai.com",
  },
  async embed(text: string, cfg: ResolvedEmbeddingConfig): Promise<number[]> {
    if (!cfg.apiKey) throw new Error("Embedding failed [openai]: api key not configured");
    const resp = await resilientFetch({
      url: `${cfg.baseUrl}/v1/embeddings`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ model: cfg.model, input: text }),
      },
      timeoutMs: cfg.timeoutMs,
      retries: cfg.retries,
      baseDelayMs: cfg.retryBaseDelayMs,
      capDelayMs: RETRY_CAP_MS,
      provider: "openai",
      model: cfg.model,
    });
    const data = (await resp.json()) as OpenAIEmbedResponse;
    const first = data.data[0];
    if (!first) throw new Error(`Embedding response from openai missing data`);
    return first.embedding;
  },
};

registerEmbeddingProvider(openaiEmbeddingProvider);
