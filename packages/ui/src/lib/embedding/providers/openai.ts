/**
 * OpenAI UI embedding provider — bearer auth.
 */

import {
  registerUIEmbeddingProvider,
  type UIEmbeddingProvider,
  type ResolvedUIEmbeddingConfig,
} from "../registry.js";

interface EmbeddingResponse { data: Array<{ embedding: number[] }> }

export const openaiUIProvider: UIEmbeddingProvider = {
  name: "openai",
  label: "OpenAI",
  browserCompatible: true,
  async embed(text: string, cfg: ResolvedUIEmbeddingConfig): Promise<number[]> {
    if (!cfg.apiKey) throw new Error("OpenAI embedding requires api_key");
    const resp = await fetch(`${cfg.baseUrl || "https://api.openai.com"}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, input: text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Embedding failed [openai/${cfg.model}] (${resp.status}): ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as EmbeddingResponse;
    const first = data.data[0];
    if (!first) throw new Error("Embedding response missing data");
    return first.embedding;
  },
};

registerUIEmbeddingProvider(openaiUIProvider);
