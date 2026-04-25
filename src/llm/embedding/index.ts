/**
 * Public embedding API.
 *
 * - initEmbedding(cfg)   — resolve provider + defaults, run optional init().
 * - embed(text)          — compute one embedding via the resolved provider.
 * - getEmbeddingConfig() — current resolved config (throws if not initialised).
 * - getEmbeddingDimensions() — convenience accessor used by Qdrant collection setup.
 *
 * Provider routing is delegated to the registry — see ./registry.ts and
 * ./providers/*.ts.
 */

// Side-effect: registers every built-in provider before anyone calls us.
import "./providers/index.js";

import { getEmbeddingProvider } from "./registry.js";
import type { ResolvedEmbeddingConfig } from "./types.js";

export type { EmbeddingProvider, ResolvedEmbeddingConfig } from "./types.js";
export {
  registerEmbeddingProvider,
  getEmbeddingProvider,
  listEmbeddingProviders,
} from "./registry.js";

export interface InitEmbeddingInput {
  provider: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  apiKey?: string | null;
  extra?: Record<string, string | undefined>;
}

let resolved: ResolvedEmbeddingConfig | null = null;

export function initEmbedding(input: InitEmbeddingInput): ResolvedEmbeddingConfig {
  const provider = getEmbeddingProvider(input.provider);
  resolved = {
    provider: provider.name,
    model: input.model ?? provider.defaults.model,
    dimensions: input.dimensions ?? provider.defaults.dimensions,
    baseUrl: (input.baseUrl ?? provider.defaults.baseUrl ?? "").replace(/\/+$/, ""),
    apiKey: input.apiKey ?? null,
    extra: input.extra ?? {},
  };
  return resolved;
}

export function getEmbeddingConfig(): ResolvedEmbeddingConfig {
  if (!resolved) throw new Error("Embedding not initialized — call initEmbedding() first");
  return resolved;
}

export function getEmbeddingDimensions(): number {
  if (!resolved) throw new Error("Embedding not initialized — call initEmbedding() first");
  return resolved.dimensions;
}

export async function embed(text: string): Promise<number[]> {
  if (!resolved) throw new Error("Embedding not initialized — call initEmbedding() first");
  if (!text?.trim()) throw new Error("embed() called with empty text");
  const provider = getEmbeddingProvider(resolved.provider);
  return provider.embed(text, resolved);
}

/** Test-only: drop cached config so initEmbedding can be called fresh. */
export function _resetEmbedding(): void {
  resolved = null;
}
