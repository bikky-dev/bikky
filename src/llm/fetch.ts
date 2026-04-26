/**
 * Resilient JSON fetch helper for LLM and embedding providers.
 *
 * Adds three things to plain `fetch()`:
 *   1. Per-request timeout (AbortSignal.timeout)
 *   2. Retry on transient HTTP failures (5xx, 408, 425), rate-limits (429,
 *      honouring Retry-After), and network errors
 *   3. Typed error classification — see `./errors.ts`
 *
 * Mirrors the patterns used by `src/lib/qdrant-client.ts` so callers can rely
 * on a single error hierarchy across LLM, embedding, and Qdrant.
 */

import {
  LlmHttpError,
  classifyFetchError,
  isRetryable,
  makeHttpError,
  parseRetryAfterMs,
  backoffDelayMs,
} from "./errors.js";

export interface ResilientFetchOptions {
  /** Endpoint URL. */
  url: string;
  /** Standard `fetch` init (method, headers, body, …). `signal` is overridden. */
  init: RequestInit;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** Max retry attempts for transient failures (excluding the first try). */
  retries: number;
  /** Base backoff in milliseconds. */
  baseDelayMs: number;
  /** Maximum backoff cap in milliseconds. */
  capDelayMs: number;
  /** Provider name (for typed errors). */
  provider: string;
  /** Model id, when known. */
  model?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * POST-with-retry wrapper. Returns a successful Response (caller still parses
 * the body). Throws a typed `LlmHttpError` on terminal failure.
 */
export async function resilientFetch(opts: ResilientFetchOptions): Promise<Response> {
  const { url, init, timeoutMs, retries, baseDelayMs, capDelayMs, provider, model } = opts;
  let attempt = 0;

  for (;;) {
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const err = classifyFetchError(e, { provider, model });
      if (isRetryable(err.kind) && attempt < retries) {
        await sleep(backoffDelayMs({ attempt, baseMs: baseDelayMs, capMs: capDelayMs }));
        attempt++;
        continue;
      }
      throw err;
    }

    if (resp.ok) return resp;

    // Non-2xx — read body once for diagnostics.
    const body = await resp.text().catch(() => "");
    const retryAfterMs = parseRetryAfterMs(resp.headers.get("retry-after"));
    const err = makeHttpError(resp.status, { provider, model, body, retryAfterMs });

    if (isRetryable(err.kind) && attempt < retries) {
      await sleep(backoffDelayMs({ attempt, baseMs: baseDelayMs, capMs: capDelayMs, retryAfterMs }));
      attempt++;
      continue;
    }
    throw err;
  }
}

/** Re-export the LlmHttpError type guard for callers that want to branch. */
export { LlmHttpError };
