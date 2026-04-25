/**
 * In-memory registry of embedding providers.
 *
 * Providers self-register from their own files — see ./providers/*.ts.
 * The registry is populated as a side-effect of importing ./providers/index.js,
 * which ./index.ts does at module top.
 */

import type { EmbeddingProvider } from "./types.js";

const providers = new Map<string, EmbeddingProvider>();

export function registerEmbeddingProvider(provider: EmbeddingProvider): void {
  providers.set(provider.name, provider);
}

export function getEmbeddingProvider(name: string): EmbeddingProvider {
  const p = providers.get(name);
  if (!p) {
    const known = [...providers.keys()].sort().join(", ") || "(none registered)";
    throw new Error(`Unknown embedding provider: "${name}". Registered: ${known}`);
  }
  return p;
}

export function listEmbeddingProviders(): EmbeddingProvider[] {
  return [...providers.values()];
}

/** Test-only: clear the registry. Not exported from the package barrel. */
export function _resetEmbeddingRegistry(): void {
  providers.clear();
}
