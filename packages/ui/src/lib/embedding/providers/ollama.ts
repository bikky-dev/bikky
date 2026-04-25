/**
 * Ollama UI embedding provider — POSTs to /v1/embeddings without auth.
 */

import {
  registerUIEmbeddingProvider,
  type UIEmbeddingProvider,
  type ResolvedUIEmbeddingConfig,
} from "../registry.js";

interface EmbeddingResponse { data: Array<{ embedding: number[] }> }

export const ollamaUIProvider: UIEmbeddingProvider = {
  name: "ollama",
  label: "Ollama (local)",
  browserCompatible: true,
  async embed(text: string, cfg: ResolvedUIEmbeddingConfig): Promise<number[]> {
    const resp = await fetch(`${cfg.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input: text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Embedding failed [ollama/${cfg.model}] (${resp.status}): ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as EmbeddingResponse;
    const first = data.data[0];
    if (!first) throw new Error("Embedding response missing data");
    return first.embedding;
  },
};

registerUIEmbeddingProvider(ollamaUIProvider);
