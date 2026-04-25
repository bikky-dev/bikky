/**
 * UI-side embedding provider registry.
 *
 * Mirrors the server-side registry in src/llm/embedding/ but only carries
 * providers that are reachable from a browser/Node-server context (i.e. no
 * AWS-SDK-bound providers like Bedrock). Adding a new provider:
 *
 *   1. Drop a file alongside ./providers/foo.ts implementing UIEmbeddingProvider
 *   2. Add a side-effect import in ./providers/index.ts
 */

export interface ResolvedUIEmbeddingConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
  extra: Record<string, string | undefined>;
}

export interface UIEmbeddingProvider {
  readonly name: string;
  readonly label: string;
  /** Whether this provider can be reached from the UI (gates semantic search). */
  readonly browserCompatible: boolean;
  embed(text: string, cfg: ResolvedUIEmbeddingConfig): Promise<number[]>;
}

const providers = new Map<string, UIEmbeddingProvider>();

export function registerUIEmbeddingProvider(p: UIEmbeddingProvider): void {
  providers.set(p.name, p);
}

export function getUIEmbeddingProvider(name: string): UIEmbeddingProvider | undefined {
  return providers.get(name);
}

export function listUIEmbeddingProviders(): UIEmbeddingProvider[] {
  return Array.from(providers.values());
}

/** Test-only: clear the registry. */
export function _resetUIEmbeddingRegistry(): void {
  providers.clear();
}
