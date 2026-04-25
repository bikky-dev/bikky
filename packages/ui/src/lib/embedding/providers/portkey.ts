/**
 * Portkey UI embedding provider — gateway with optional virtual-key/config.
 */

import {
  registerUIEmbeddingProvider,
  type UIEmbeddingProvider,
  type ResolvedUIEmbeddingConfig,
} from "../registry.js";

interface EmbeddingResponse { data: Array<{ embedding: number[] }> }

export const portkeyUIProvider: UIEmbeddingProvider = {
  name: "portkey",
  label: "Portkey (gateway)",
  browserCompatible: true,
  async embed(text: string, cfg: ResolvedUIEmbeddingConfig): Promise<number[]> {
    if (!cfg.apiKey) throw new Error("Portkey embedding requires api_key");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-portkey-api-key": cfg.apiKey,
    };
    if (cfg.extra.virtual_key) headers["x-portkey-virtual-key"] = cfg.extra.virtual_key;
    if (cfg.extra.config_id) headers["x-portkey-config"] = cfg.extra.config_id;

    const resp = await fetch(`${cfg.baseUrl || "https://api.portkey.ai"}/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, input: text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Embedding failed [portkey/${cfg.model}] (${resp.status}): ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as EmbeddingResponse;
    const first = data.data[0];
    if (!first) throw new Error("Embedding response missing data");
    return first.embedding;
  },
};

registerUIEmbeddingProvider(portkeyUIProvider);
