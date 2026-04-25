/**
 * Shared Qdrant HTTP client used by both the daemon and the MCP server.
 *
 * Adds the resilience features that the previous inline `fetch` wrappers lacked:
 *   - per-request timeout via AbortSignal
 *   - retry with exponential backoff + jitter on transient errors (5xx, 408, 425)
 *   - 429 handling that honours Retry-After
 *   - typed errors so callers can branch on status class instead of string-matching
 *
 * The client is intentionally minimal — it exposes a generic `request<T>` and a
 * dedicated `ensureCollection` helper. Higher-level Qdrant operations
 * (search/scroll/upsert/etc.) stay in the daemon and MCP modules so this lib
 * does not need to know about payload shapes.
 */

export type QdrantLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type QdrantLogFn = (level: QdrantLogLevel, msg: string) => void;

export interface QdrantClientOptions {
  url: string;
  apiKey: string;
  collection: string;
  /** Per-request timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Max retry attempts for transient errors (default 3). 0 disables retries. */
  retries?: number;
  /** Base delay for exponential backoff in ms (default 250). */
  retryBaseDelayMs?: number;
  /** Optional logger — quiet by default. */
  log?: QdrantLogFn;
}

export interface QdrantRequestOptions {
  /** Override the client default for this call. */
  timeoutMs?: number;
  /** Override the client default for this call. */
  retries?: number;
}

export interface QdrantIndexSpec {
  field_name: string;
  field_schema: string;
}

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

export class QdrantError extends Error {
  readonly status?: number;
  readonly responseBody?: string;

  constructor(message: string, status?: number, responseBody?: string) {
    super(message);
    this.name = "QdrantError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

/** 401 / 403 — credentials are missing, wrong, or revoked. Not retried. */
export class QdrantAuthError extends QdrantError {
  constructor(message: string, status?: number, responseBody?: string) {
    super(message, status, responseBody);
    this.name = "QdrantAuthError";
  }
}

/** 404 — collection or point not found. Not retried. */
export class QdrantNotFoundError extends QdrantError {
  constructor(message: string, status?: number, responseBody?: string) {
    super(message, status, responseBody);
    this.name = "QdrantNotFoundError";
  }
}

/** 429 — rate limit. Retried (Retry-After honoured if present). */
export class QdrantRateLimitError extends QdrantError {
  readonly retryAfterMs?: number;
  constructor(message: string, status?: number, responseBody?: string, retryAfterMs?: number) {
    super(message, status, responseBody);
    this.name = "QdrantRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** 408, 425, 5xx, network failures, timeouts. Retried. */
export class QdrantTransientError extends QdrantError {
  constructor(message: string, status?: number, responseBody?: string) {
    super(message, status, responseBody);
    this.name = "QdrantTransientError";
  }
}

/** 400, 422 — malformed request. Not retried. */
export class QdrantBadRequestError extends QdrantError {
  constructor(message: string, status?: number, responseBody?: string) {
    super(message, status, responseBody);
    this.name = "QdrantBadRequestError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const MAX_BACKOFF_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const jitter = (base: number): number => {
  const factor = 0.8 + Math.random() * 0.4; // ±20%
  return Math.round(base * factor);
};

const parseRetryAfter = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  // HTTP date format
  const ts = Date.parse(header);
  if (Number.isFinite(ts)) {
    const delta = ts - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
};

const classifyStatus = (
  status: number,
  responseBody: string,
  method: string,
  path: string,
  retryAfterMs: number | undefined,
): QdrantError => {
  const summary = responseBody.slice(0, 500);
  const message = `Qdrant ${method} ${path} failed (${status}): ${summary}`;
  if (status === 401 || status === 403) return new QdrantAuthError(message, status, responseBody);
  if (status === 404) return new QdrantNotFoundError(message, status, responseBody);
  if (status === 429) return new QdrantRateLimitError(message, status, responseBody, retryAfterMs);
  if (status === 408 || status === 425 || status >= 500) {
    return new QdrantTransientError(message, status, responseBody);
  }
  if (status === 400 || status === 422) return new QdrantBadRequestError(message, status, responseBody);
  return new QdrantError(message, status, responseBody);
};

export class QdrantClient {
  private readonly url: string;
  private readonly apiKey: string;
  readonly collection: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly log: QdrantLogFn;

  constructor(opts: QdrantClientOptions) {
    if (!opts.url) throw new Error("QdrantClient: url is required");
    if (!opts.apiKey) throw new Error("QdrantClient: apiKey is required");
    if (!opts.collection) throw new Error("QdrantClient: collection is required");
    this.url = opts.url.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.collection = opts.collection;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.log = opts.log ?? ((): void => {});
  }

  /**
   * Perform a single Qdrant REST request. Retries transient errors and 429s
   * with exponential backoff. Errors are classified into the typed hierarchy.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: QdrantRequestOptions,
  ): Promise<T> {
    const maxAttempts = (opts?.retries ?? this.retries) + 1;
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        return await this.doRequest<T>(method, path, body, timeoutMs);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof QdrantTransientError || err instanceof QdrantRateLimitError;
        if (!retryable || attempt >= maxAttempts) throw err;

        const baseDelay =
          err instanceof QdrantRateLimitError && err.retryAfterMs !== undefined
            ? err.retryAfterMs
            : Math.min(this.retryBaseDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        const delay = jitter(baseDelay);
        const status = err instanceof QdrantError ? err.status ?? "?" : "?";
        this.log(
          "WARN",
          `Qdrant retry ${attempt}/${maxAttempts - 1} after ${status} on ${method} ${path} (sleeping ${delay}ms)`,
        );
        await sleep(delay);
      }
    }

    // Defensive — loop always either returns or throws.
    throw lastErr instanceof Error ? lastErr : new QdrantError(String(lastErr));
  }

  private async doRequest<T>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const url = `${this.url}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "api-key": this.apiKey,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    let signal: AbortSignal | undefined;
    if (timeoutMs > 0) {
      // AbortSignal.timeout is available in Node >= 17.3
      signal = AbortSignal.timeout(timeoutMs);
      init.signal = signal;
    }

    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      const isAbort =
        (err instanceof DOMException && err.name === "TimeoutError") ||
        (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
      if (isAbort) {
        throw new QdrantTransientError(
          `Qdrant ${method} ${path} timed out after ${timeoutMs}ms`,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new QdrantTransientError(`Qdrant ${method} ${path} network error: ${msg}`);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
      throw classifyStatus(resp.status, text, method, path, retryAfter);
    }

    // Some Qdrant endpoints (rare) return empty bodies on success.
    const text = await resp.text();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new QdrantError(
        `Qdrant ${method} ${path} returned invalid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
        resp.status,
        text.slice(0, 500),
      );
    }
  }

  /**
   * Ensure the configured collection exists with the given vector size, then
   * (re-)create the supplied payload indexes. Index creation failures are
   * logged but not fatal — Qdrant returns an error when an index already
   * exists, and we want this to be idempotent.
   */
  async ensureCollection(vectorSize: number, indexes: ReadonlyArray<QdrantIndexSpec>): Promise<void> {
    const col = this.collection;

    let exists = false;
    try {
      await this.request<unknown>("GET", `/collections/${col}`);
      exists = true;
    } catch (err) {
      if (!(err instanceof QdrantNotFoundError)) throw err;
    }

    if (!exists) {
      await this.request<unknown>("PUT", `/collections/${col}`, {
        vectors: { size: vectorSize, distance: "Cosine" },
      });
      this.log("INFO", `Qdrant collection '${col}' created (vector size ${vectorSize})`);
    } else {
      this.log("DEBUG", `Qdrant collection '${col}' already exists`);
    }

    for (const idx of indexes) {
      try {
        await this.request<unknown>("PUT", `/collections/${col}/index`, idx);
      } catch (err) {
        // Index already-exists / harmless conflicts surface as 4xx — log and continue.
        this.log(
          "WARN",
          `Qdrant index ${idx.field_name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
