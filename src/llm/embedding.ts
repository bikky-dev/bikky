/**
 * Embedding provider — config-driven, supports Ollama (default), OpenAI, and Bedrock.
 *
 * Ollama uses the OpenAI-compatible /v1/embeddings HTTP format.
 * OpenAI uses the same /v1/embeddings format with an API key.
 * Bedrock uses AWS SDK with Titan Embed V2.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

import type { EmbeddingProviderConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

interface TitanEmbedResponse {
  embedding: number[];
}

// ---------------------------------------------------------------------------
// Provider defaults
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULTS: Record<string, Omit<EmbeddingProviderConfig, "apiKey">> = {
  ollama: {
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
  },
  openai: {
    provider: "openai",
    baseUrl: "https://api.openai.com",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  bedrock: {
    provider: "bedrock",
    baseUrl: "",
    model: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let config: EmbeddingProviderConfig | null = null;
let bedrockClient: BedrockRuntimeClient | null = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initEmbedding(overrides: Partial<EmbeddingProviderConfig> = {}): EmbeddingProviderConfig {
  const provider = overrides.provider ?? "ollama";
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.ollama!;

  config = {
    provider,
    baseUrl: (overrides.baseUrl ?? defaults.baseUrl).replace(/\/+$/, ""),
    model: overrides.model ?? defaults.model,
    dimensions: overrides.dimensions ?? defaults.dimensions,
    apiKey: overrides.apiKey ?? null,
  };

  if (provider === "bedrock") {
    const region = process.env.AWS_BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
    const credentials = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined;
    bedrockClient = new BedrockRuntimeClient({ region, credentials });
  }

  return config;
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getEmbeddingConfig(): EmbeddingProviderConfig {
  if (!config) throw new Error("Embedding not initialized — call initEmbedding() first");
  return config;
}

export function getEmbeddingDimensions(): number {
  if (!config) throw new Error("Embedding not initialized — call initEmbedding() first");
  return config.dimensions;
}

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

export async function embed(text: string): Promise<number[]> {
  if (!config) throw new Error("Embedding not initialized — call initEmbedding() first");
  if (!text?.trim()) throw new Error("embed() called with empty text");

  if (config.provider === "bedrock") return bedrockEmbed(text);

  // Ollama and OpenAI both use OpenAI-compatible /v1/embeddings
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.provider === "openai" && config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const resp = await fetch(`${config.baseUrl}/v1/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: config.model, input: text }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Embedding failed [${config.provider}/${config.model}] (${resp.status}): ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as EmbeddingResponse;
  const first = data.data[0];
  if (!first) throw new Error(`Embedding response from ${config.provider} missing data`);
  return first.embedding;
}

// ---------------------------------------------------------------------------
// Bedrock Embed (Titan Embed V2)
// ---------------------------------------------------------------------------

async function bedrockEmbed(text: string): Promise<number[]> {
  if (!bedrockClient) {
    const region = process.env.AWS_BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
    const credentials = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined;
    bedrockClient = new BedrockRuntimeClient({ region, credentials });
  }

  const payload = JSON.stringify({
    inputText: text,
    dimensions: config!.dimensions,
    normalize: true,
  });

  const command = new InvokeModelCommand({
    modelId: config!.model,
    contentType: "application/json",
    accept: "application/json",
    body: new TextEncoder().encode(payload),
  });

  const resp = await bedrockClient.send(command);
  const raw = JSON.parse(new TextDecoder().decode(resp.body)) as TitanEmbedResponse;

  if (!raw.embedding) {
    throw new Error(`Bedrock embedding response missing data (model: ${config!.model})`);
  }
  return raw.embedding;
}
