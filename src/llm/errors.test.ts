import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHttpStatus,
  makeHttpError,
  classifyFetchError,
  parseRetryAfterMs,
  backoffDelayMs,
  isRetryable,
  LlmAuthError,
  LlmRateLimitError,
  LlmBadRequestError,
  LlmTransientError,
  LlmTimeoutError,
  LlmUnknownError,
  EmbeddingDimensionMismatchError,
} from "./errors.js";

describe("classifyHttpStatus", () => {
  it("maps 401/403 → auth, 429 → rate_limit, 400/422 → bad_request, 5xx → transient", () => {
    assert.equal(classifyHttpStatus(401), "auth");
    assert.equal(classifyHttpStatus(403), "auth");
    assert.equal(classifyHttpStatus(429), "rate_limit");
    assert.equal(classifyHttpStatus(400), "bad_request");
    assert.equal(classifyHttpStatus(422), "bad_request");
    assert.equal(classifyHttpStatus(404), "bad_request");
    assert.equal(classifyHttpStatus(500), "transient");
    assert.equal(classifyHttpStatus(503), "transient");
    assert.equal(classifyHttpStatus(408), "transient");
  });
});

describe("makeHttpError", () => {
  it("returns the right subclass for each status", () => {
    assert.ok(makeHttpError(401, { provider: "openai" }) instanceof LlmAuthError);
    assert.ok(makeHttpError(429, { provider: "openai" }) instanceof LlmRateLimitError);
    assert.ok(makeHttpError(404, { provider: "openai" }) instanceof LlmBadRequestError);
    assert.ok(makeHttpError(503, { provider: "openai" }) instanceof LlmTransientError);
    assert.ok(makeHttpError(301, { provider: "openai" }) instanceof LlmUnknownError);
  });
  it("formats message as [provider/model] (status): body", () => {
    const err = makeHttpError(404, {
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      body: "model not found",
    });
    assert.match(err.message, /\[ollama\/qwen3-embedding:0\.6b\] \(404\): model not found/);
  });
  it("preserves provider, status, body, kind", () => {
    const err = makeHttpError(429, { provider: "p", body: "slow down", retryAfterMs: 1000 });
    assert.equal(err.kind, "rate_limit");
    assert.equal(err.status, 429);
    assert.equal(err.provider, "p");
    assert.equal(err.retryAfterMs, 1000);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses integer seconds", () => {
    assert.equal(parseRetryAfterMs("5"), 5_000);
  });
  it("caps at 60s", () => {
    assert.equal(parseRetryAfterMs("9999"), 60_000);
  });
  it("returns undefined for null / invalid input", () => {
    assert.equal(parseRetryAfterMs(null), undefined);
    assert.equal(parseRetryAfterMs("abc"), undefined);
  });
});

describe("backoffDelayMs", () => {
  it("respects cap with full jitter", () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const d = backoffDelayMs({ attempt, baseMs: 100, capMs: 2_000 });
      assert.ok(d >= 0 && d <= 2_000, `attempt ${attempt} produced ${d}`);
    }
  });
  it("honours retryAfterMs (capped)", () => {
    assert.equal(backoffDelayMs({ attempt: 0, baseMs: 100, capMs: 2_000, retryAfterMs: 5_000 }), 2_000);
    assert.equal(backoffDelayMs({ attempt: 0, baseMs: 100, capMs: 10_000, retryAfterMs: 500 }), 500);
  });
});

describe("isRetryable", () => {
  it("retries timeout / rate_limit / transient", () => {
    assert.ok(isRetryable("timeout"));
    assert.ok(isRetryable("rate_limit"));
    assert.ok(isRetryable("transient"));
  });
  it("does NOT retry auth / bad_request / unknown", () => {
    assert.equal(isRetryable("auth"), false);
    assert.equal(isRetryable("bad_request"), false);
    assert.equal(isRetryable("unknown"), false);
  });
});

describe("classifyFetchError", () => {
  it("maps TimeoutError → LlmTimeoutError", () => {
    const e = new Error("timeout");
    e.name = "TimeoutError";
    assert.ok(classifyFetchError(e, { provider: "p" }) instanceof LlmTimeoutError);
  });
  it("maps AbortError → LlmTimeoutError", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    assert.ok(classifyFetchError(e, { provider: "p" }) instanceof LlmTimeoutError);
  });
  it("maps generic network error → LlmTransientError", () => {
    const e = new TypeError("fetch failed");
    assert.ok(classifyFetchError(e, { provider: "p" }) instanceof LlmTransientError);
  });
});

describe("EmbeddingDimensionMismatchError", () => {
  it("includes provider, model, expected, actual", () => {
    const e = new EmbeddingDimensionMismatchError("openai", "text-embedding-3-small", 1536, 768);
    assert.equal(e.provider, "openai");
    assert.equal(e.expected, 1536);
    assert.equal(e.actual, 768);
    assert.match(e.message, /1536/);
    assert.match(e.message, /768/);
  });
});
