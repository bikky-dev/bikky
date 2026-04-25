/**
 * Ollama embedding provider — local /v1/embeddings (OpenAI-compatible).
 */

import { registerEmbeddingProvider } from "../registry.js";
import type { EmbeddingProvider, ResolvedEmbeddingConfig } from "../types.js";

interface OpenAICompatResponse {
  data: Array<{ embedding: number[] }>;
}

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
    const resp = await fetch(`${cfg.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input: text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Embedding failed [ollama/${cfg.model}] (${resp.status}): ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as OpenAICompatResponse;
    const first = data.data[0];
    if (!first) throw new Error(`Embedding response from ollama missing data`);
    return first.embedding;
  },
};

registerEmbeddingProvider(ollamaEmbeddingProvider);
