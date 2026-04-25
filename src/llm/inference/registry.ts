/**
 * In-process registry of inference providers.
 *
 * Providers self-register at module load by importing this file's
 * `registerInferenceProvider`. The barrel `./providers/index.ts` is imported by
 * `./index.ts` so that any consumer of the public API automatically pulls in
 * the bundled providers.
 */

import type { InferenceProvider } from "./types.js";

const providers = new Map<string, InferenceProvider>();

export function registerInferenceProvider(p: InferenceProvider): void {
  providers.set(p.name, p);
}

export function getInferenceProvider(name: string): InferenceProvider {
  const p = providers.get(name);
  if (!p) {
    const known = Array.from(providers.keys()).sort().join(", ") || "(none)";
    throw new Error(`Unknown inference provider: "${name}". Registered: ${known}`);
  }
  return p;
}

export function listInferenceProviders(): InferenceProvider[] {
  return Array.from(providers.values());
}

/** Test-only: clear the registry. */
export function _resetInferenceRegistry(): void {
  providers.clear();
}
