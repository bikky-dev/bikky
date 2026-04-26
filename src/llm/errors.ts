/**
 * Shared error hierarchy for LLM (inference) and embedding providers.
 *
 * Models the same shape as `src/lib/qdrant-client.ts` so callers can branch on
 * type instead of string-matching log messages. Inference providers catch these
 * internally and degrade to `null` for the fallback chain (see
 * `src/llm/inference/index.ts`); embedding providers re-throw them so callers
 * can surface a meaningful reason.
 */

export type LlmErrorClass =
  | "auth"
  | "rate_limit"
  | "bad_request"
  | "transient"
  | "timeout"
  | "unknown";

export interface LlmErrorDetails {
  /** Provider name, e.g. "openai", "portkey". */
  provider: string;
  /** Model id, when known. */
  model?: string;
  /** HTTP status code, when the failure was an HTTP response. */
  status?: number;
  /** Truncated response body, when available. */
  body?: string;
  /** Retry-After header value (seconds) for rate-limit responses. */
  retryAfterMs?: number;
  /** Underlying cause, when this wraps another error. */
  cause?: unknown;
}

/**
 * Base class for all LLM/embedding HTTP failures. Subclasses set `kind` so that
 * `instanceof` and `kind === "..."` both work.
 */
export class LlmHttpError extends Error {
  public readonly kind: LlmErrorClass;
  public readonly provider: string;
  public readonly model?: string;
  public readonly status?: number;
  public readonly body?: string;
  public readonly retryAfterMs?: number;

  constructor(kind: LlmErrorClass, message: string, details: LlmErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.provider = details.provider;
    this.model = details.model;
    this.status = details.status;
    this.body = details.body;
    this.retryAfterMs = details.retryAfterMs;
    if (details.cause !== undefined) {
      // Preserve the underlying cause for stack-trace inspection.
      (this as { cause?: unknown }).cause = details.cause;
    }
  }
}

export class LlmAuthError extends LlmHttpError {
  constructor(details: LlmErrorDetails) {
    super("auth", buildMessage(details), details);
  }
}

export class LlmBadRequestError extends LlmHttpError {
  constructor(details: LlmErrorDetails) {
    super("bad_request", buildMessage(details), details);
  }
}

export class LlmRateLimitError extends LlmHttpError {
  constructor(details: LlmErrorDetails) {
    super("rate_limit", buildMessage(details), details);
  }
}

export class LlmTransientError extends LlmHttpError {
  constructor(details: LlmErrorDetails) {
    super("transient", buildMessage(details), details);
  }
}

export class LlmTimeoutError extends LlmHttpError {
  constructor(details: LlmErrorDetails) {
    super("timeout", buildMessage({ ...details, body: details.body ?? "request timed out" }), details);
  }
}

export class LlmUnknownError extends LlmHttpError {
  constructor(details: LlmErrorDetails) {
    super("unknown", buildMessage(details), details);
  }
}

/** Convenience: vector-dimension mismatch — config says X, model returned Y. */
export class EmbeddingDimensionMismatchError extends Error {
  public readonly provider: string;
  public readonly model: string;
  public readonly expected: number;
  public readonly actual: number;
  constructor(provider: string, model: string, expected: number, actual: number) {
    super(
      `Embedding dimension mismatch [${provider}/${model}]: config.embedding.dimensions=${expected} but the model returned ${actual}. ` +
      `Update embedding.dimensions in ~/.bikky/config.json (or via configure_credentials) and re-create the Qdrant collection.`,
    );
    this.name = "EmbeddingDimensionMismatchError";
    this.provider = provider;
    this.model = model;
    this.expected = expected;
    this.actual = actual;
  }
}

function buildMessage(d: LlmErrorDetails): string {
  const target = d.model ? `${d.provider}/${d.model}` : d.provider;
  const statusPart = d.status !== undefined ? ` (${d.status})` : "";
  const bodyPart = d.body ? `: ${d.body.slice(0, 200)}` : "";
  return `[${target}]${statusPart}${bodyPart}`;
}

/**
 * Map an HTTP status code to a typed error class.
 * Mirrors the classification in `src/lib/qdrant-client.ts:classifyStatus`.
 */
export function classifyHttpStatus(status: number): LlmErrorClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 422) return "bad_request";
  if (status === 408 || status === 425 || status >= 500) return "transient";
  if (status >= 200 && status < 300) return "unknown"; // never used — caller must check ok
  if (status >= 400) return "bad_request";
  return "unknown";
}

/** Build the right error subclass for an HTTP failure. */
export function makeHttpError(status: number, details: Omit<LlmErrorDetails, "status">): LlmHttpError {
  const full: LlmErrorDetails = { ...details, status };
  switch (classifyHttpStatus(status)) {
    case "auth": return new LlmAuthError(full);
    case "rate_limit": return new LlmRateLimitError(full);
    case "bad_request": return new LlmBadRequestError(full);
    case "transient": return new LlmTransientError(full);
    default: return new LlmUnknownError(full);
  }
}

/**
 * Map a thrown fetch error (network/abort) to a typed error.
 *
 * - DOMException `name === "TimeoutError"` (from AbortSignal.timeout) → LlmTimeoutError
 * - Anything else (DNS, ECONNRESET, etc.) → LlmTransientError
 */
export function classifyFetchError(err: unknown, details: Omit<LlmErrorDetails, "status">): LlmHttpError {
  const e = err as { name?: string; message?: string };
  const isAbort = e?.name === "TimeoutError" || e?.name === "AbortError";
  const ctx: LlmErrorDetails = { ...details, cause: err, body: e?.message };
  return isAbort ? new LlmTimeoutError(ctx) : new LlmTransientError(ctx);
}

/**
 * Parse a Retry-After header (seconds or HTTP date) into milliseconds, capped
 * at 60s to avoid runaway sleeps.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds, 60) * 1000;
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(delta, 60_000);
  }
  return undefined;
}

/**
 * Sleep with exponential backoff + jitter, optionally honouring a server-sent
 * Retry-After hint. Mirrors `src/lib/qdrant-client.ts` semantics.
 */
export function backoffDelayMs(opts: {
  attempt: number;
  baseMs: number;
  capMs: number;
  retryAfterMs?: number;
}): number {
  if (opts.retryAfterMs !== undefined) return Math.min(opts.retryAfterMs, opts.capMs);
  const exp = Math.min(opts.capMs, opts.baseMs * 2 ** opts.attempt);
  // Full jitter: random in [0, exp).
  return Math.floor(Math.random() * exp);
}

/** True when an error class is worth retrying. */
export function isRetryable(kind: LlmErrorClass): boolean {
  return kind === "transient" || kind === "rate_limit" || kind === "timeout";
}
