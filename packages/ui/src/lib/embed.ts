/**
 * Lightweight embedding client for @bikky/ui.
 * Supports Ollama and OpenAI via HTTP — no AWS SDK needed.
 * Bedrock users should configure Ollama or OpenAI as the embedding provider.
 */

import { loadConfig } from "./config.js";

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

let _initialized = false;

export function isEmbeddingAvailable(): boolean {
  const cfg = loadConfig();
  if (cfg.embedding.provider === "bedrock") return false;
  return true;
}

export async function embed(text: string): Promise<number[]> {
  const cfg = loadConfig();

  if (cfg.embedding.provider === "bedrock") {
    throw new Error(
      "Bedrock embeddings require AWS SDK. Configure Ollama or OpenAI as embedding provider for the UI.",
    );
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.embedding.provider === "openai" && cfg.embedding.api_key) {
    headers["Authorization"] = `Bearer ${cfg.embedding.api_key}`;
  }

  const baseUrl = cfg.embedding.base_url.replace(/\/+$/, "");
  const resp = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: cfg.embedding.model, input: text }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Embedding failed [${cfg.embedding.provider}/${cfg.embedding.model}] (${resp.status}): ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as EmbeddingResponse;
  const first = data.data[0];
  if (!first) throw new Error("Embedding response missing data");
  _initialized = true;
  return first.embedding;
}
