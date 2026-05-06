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
 *
 * Errors: providers throw typed `LlmHttpError` subclasses (see `../errors.ts`)
 * — `LlmAuthError`, `LlmRateLimitError`, `LlmTransientError`, `LlmTimeoutError`,
 * `LlmBadRequestError`. Dimension mismatches throw
 * `EmbeddingDimensionMismatchError`. Callers should catch these and convert
 * to a user-facing message rather than letting them leak through MCP transport.
 */

// Side-effect: registers every built-in provider before anyone calls us.
import "./providers/index.js";

import { getEmbeddingProvider } from "./registry.js";
import { EmbeddingDimensionMismatchError } from "../errors.js";
import { firstNonEmptyString } from "../util.js";
import type { ResolvedEmbeddingConfig } from "./types.js";

export type { EmbeddingProvider, ResolvedEmbeddingConfig } from "./types.js";
export {
  registerEmbeddingProvider,
  getEmbeddingProvider,
  listEmbeddingProviders,
} from "./registry.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;

export interface InitEmbeddingInput {
  provider: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  apiKey?: string | null;
  extra?: Record<string, string | undefined>;
  /** Per-request HTTP timeout. Defaults to 30s. */
  timeoutMs?: number;
  /** Max retries on transient/rate-limit/timeout failures. Defaults to 2. */
  retries?: number;
  /** Base backoff delay (ms) for retries. Defaults to 250ms. */
  retryBaseDelayMs?: number;
}

let resolved: ResolvedEmbeddingConfig | null = null;
/** Tracks whether we've successfully validated the model's actual dimensions. */
let dimensionsValidated = false;

export function initEmbedding(input: InitEmbeddingInput): ResolvedEmbeddingConfig {
  const provider = getEmbeddingProvider(input.provider);
  resolved = {
    provider: provider.name,
    model: input.model ?? provider.defaults.model,
    dimensions: input.dimensions ?? provider.defaults.dimensions,
    baseUrl: (firstNonEmptyString(input.baseUrl, provider.defaults.baseUrl) ?? "").replace(/\/+$/, ""),
    apiKey: input.apiKey ?? null,
    extra: input.extra ?? {},
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: input.retries ?? DEFAULT_RETRIES,
    retryBaseDelayMs: input.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
  };
  dimensionsValidated = false;
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
  const vec = await provider.embed(text, resolved);

  // First-success dimension validation. Catches the classic "config says
  // 1536 but the model returns 3072" foot-gun before it cascades into a
  // cryptic Qdrant 400 "vector size mismatch".
  if (!dimensionsValidated) {
    if (vec.length !== resolved.dimensions) {
      throw new EmbeddingDimensionMismatchError(
        resolved.provider,
        resolved.model,
        resolved.dimensions,
        vec.length,
      );
    }
    dimensionsValidated = true;
  }
  return vec;
}

/** Test-only: drop cached config so initEmbedding can be called fresh. */
export function _resetEmbedding(): void {
  resolved = null;
  dimensionsValidated = false;
}
