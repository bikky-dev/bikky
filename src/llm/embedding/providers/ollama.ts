/**
 * Ollama embedding provider — local /v1/embeddings (OpenAI-compatible).
 */

import { registerEmbeddingProvider } from "../registry.js";
import { resilientFetch } from "../../fetch.js";
import type { EmbeddingProvider, ResolvedEmbeddingConfig } from "../types.js";

interface OpenAICompatResponse {
  data: Array<{ embedding: number[] }>;
}

const RETRY_CAP_MS = 5_000;

export const ollamaEmbeddingProvider: EmbeddingProvider = {
  name: "ollama",
  label: "Ollama (local)",
  browserCompatible: true,
  defaults: {
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    baseUrl: "http://localhost:11434",
  },
  async embed(text: string, cfg: ResolvedEmbeddingConfig): Promise<number[]> {
    const resp = await resilientFetch({
      url: `${cfg.baseUrl}/v1/embeddings`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.model, input: text }),
      },
      timeoutMs: cfg.timeoutMs,
      retries: cfg.retries,
      baseDelayMs: cfg.retryBaseDelayMs,
      capDelayMs: RETRY_CAP_MS,
      provider: "ollama",
      model: cfg.model,
    });
    const data = (await resp.json()) as OpenAICompatResponse;
    const first = data.data[0];
    if (!first) throw new Error(`Embedding response from ollama missing data`);
    return first.embedding;
  },
};

registerEmbeddingProvider(ollamaEmbeddingProvider);
