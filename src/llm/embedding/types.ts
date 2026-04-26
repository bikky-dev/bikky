/**
 * Embedding provider interface.
 *
 * Each embedding backend (Ollama, OpenAI, Bedrock, Portkey, …) lives in its
 * own file under ./providers/ and self-registers via registerEmbeddingProvider().
 * Adding a new provider is a single-file change — no edits to dispatchers,
 * no edits to config types, no edits to UI gates.
 *
 * See CONTRIBUTING.md → "Adding a provider" for the recipe.
 */

import type { LogFn } from "../types.js";

export type { LogFn };

/**
 * Resolved per-call embedding configuration. Built once by initEmbedding()
 * from the user's config + the provider's defaults, then passed to embed()
 * on every call.
 */
export interface ResolvedEmbeddingConfig {
  /** Provider name — matches EmbeddingProvider.name. */
  provider: string;
  /** Model identifier. Provider-specific (e.g. "text-embedding-3-small", "@openai/text-embedding-3-small"). */
  model: string;
  /** Output vector dimensions. The Qdrant collection is created with this. */
  dimensions: number;
  /** HTTP base URL (no trailing slash). Empty for SDK-only providers like Bedrock. */
  baseUrl: string;
  /** API key, or null for unauthenticated/SDK providers. */
  apiKey: string | null;
  /** Provider-specific bag — region for Bedrock, virtual_key for Portkey, project_id for Vertex, … */
  extra: Record<string, string | undefined>;
  /** Per-request timeout in milliseconds (HTTP providers). Defaults set by initEmbedding. */
  timeoutMs: number;
  /** Max retries on transient/rate-limit/timeout failures. */
  retries: number;
  /** Base backoff delay in milliseconds (full-jitter exponential). */
  retryBaseDelayMs: number;
}

export interface EmbeddingProvider {
  /** Stable identifier used in config (e.g. "ollama"). Lowercase, no spaces. */
  readonly name: string;
  /** Human label for logs and tooling. */
  readonly label: string;
  /** Defaults applied when the user picks this provider with no overrides. */
  readonly defaults: {
    model: string;
    dimensions: number;
    /** Default HTTP base URL. Omit for SDK-only providers. */
    baseUrl?: string;
  };
  /** Whether this provider can be called from a browser (UI uses this to gate semantic search). */
  readonly browserCompatible: boolean;
  /** Compute one embedding. Providers that need heavy SDKs should dynamic-import on first call. */
  embed(text: string, cfg: ResolvedEmbeddingConfig): Promise<number[]>;
}
