/**
 * Tests for the shared QdrantClient.
 *
 * No real network — `globalThis.fetch` is monkey-patched per test to return
 * scripted responses or throw scripted errors.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  QdrantClient,
  QdrantAuthError,
  QdrantBadRequestError,
  QdrantNotFoundError,
  QdrantRateLimitError,
  QdrantTransientError,
} from "./qdrant-client.js";

type ScriptedResponse = {
  status: number;
  body?: string;
  headers?: Record<string, string>;
};
type ScriptedError = { error: Error };
type ScriptedStep = ScriptedResponse | ScriptedError;

const buildResponse = (step: ScriptedResponse): Response => {
  const body = step.body ?? "";
  return new Response(body, { status: step.status, headers: step.headers });
};

const installFetchMock = (
  steps: ScriptedStep[],
): { calls: Array<{ url: string; init?: RequestInit }>; restore: () => void } => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const step = steps[i++];
    if (!step) throw new Error(`fetch mock exhausted after ${i} call(s)`);
    if ("error" in step) throw step.error;
    return buildResponse(step);
  }) as typeof fetch;
  return {
    calls,
    restore: (): void => {
      globalThis.fetch = original;
    },
  };
};

const baseOpts = {
  url: "https://example.qdrant.io",
  apiKey: "test-key",
  collection: "bikky-test",
  retryBaseDelayMs: 1, // keep tests fast
};

describe("QdrantClient", () => {
  let mock: ReturnType<typeof installFetchMock> | null = null;

  afterEach(() => {
    if (mock) {
      mock.restore();
      mock = null;
    }
  });

  describe("request — happy path", () => {
    it("parses JSON success response and sends api-key header", async () => {
      mock = installFetchMock([{ status: 200, body: JSON.stringify({ result: { ok: true } }) }]);
      const client = new QdrantClient(baseOpts);
      const out = await client.request<{ result: { ok: boolean } }>("GET", "/collections");
      assert.deepEqual(out, { result: { ok: true } });
      assert.equal(mock.calls.length, 1);
      assert.equal(mock.calls[0].url, "https://example.qdrant.io/collections");
      const headers = mock.calls[0].init?.headers as Record<string, string>;
      assert.equal(headers["api-key"], "test-key");
      assert.equal(headers["Content-Type"], "application/json");
    });

    it("strips trailing slashes from the configured URL", async () => {
      mock = installFetchMock([{ status: 200, body: "{}" }]);
      const client = new QdrantClient({ ...baseOpts, url: "https://example.qdrant.io///" });
      await client.request("GET", "/collections");
      assert.equal(mock.calls[0].url, "https://example.qdrant.io/collections");
    });

    it("returns undefined for empty success bodies", async () => {
      mock = installFetchMock([{ status: 200, body: "" }]);
      const client = new QdrantClient(baseOpts);
      const out = await client.request("GET", "/collections/foo");
      assert.equal(out, undefined);
    });
  });

  describe("error classification", () => {
    it("401 → QdrantAuthError, no retry", async () => {
      mock = installFetchMock([{ status: 401, body: "unauthorized" }]);
      const client = new QdrantClient(baseOpts);
      await assert.rejects(() => client.request("GET", "/collections"), QdrantAuthError);
      assert.equal(mock.calls.length, 1);
    });

    it("404 → QdrantNotFoundError, no retry", async () => {
      mock = installFetchMock([{ status: 404, body: "not found" }]);
      const client = new QdrantClient(baseOpts);
      await assert.rejects(() => client.request("GET", "/collections/missing"), QdrantNotFoundError);
      assert.equal(mock.calls.length, 1);
    });

    it("400 → QdrantBadRequestError, no retry", async () => {
      mock = installFetchMock([{ status: 400, body: "bad request" }]);
      const client = new QdrantClient(baseOpts);
      await assert.rejects(() => client.request("PUT", "/collections/foo", {}), QdrantBadRequestError);
      assert.equal(mock.calls.length, 1);
    });
  });

  describe("retry on transient errors", () => {
    it("retries 503 then succeeds", async () => {
      mock = installFetchMock([
        { status: 503, body: "service unavailable" },
        { status: 200, body: JSON.stringify({ ok: true }) },
      ]);
      const client = new QdrantClient(baseOpts);
      const out = await client.request<{ ok: boolean }>("POST", "/collections/foo/points/search");
      assert.deepEqual(out, { ok: true });
      assert.equal(mock.calls.length, 2);
    });

    it("retries network failure (TypeError) then succeeds", async () => {
      mock = installFetchMock([
        { error: new TypeError("network down") },
        { status: 200, body: "{}" },
      ]);
      const client = new QdrantClient(baseOpts);
      await client.request("GET", "/collections");
      assert.equal(mock.calls.length, 2);
    });

    it("exhausts retries and throws QdrantTransientError", async () => {
      mock = installFetchMock([
        { status: 502, body: "bad gateway" },
        { status: 502, body: "bad gateway" },
        { status: 502, body: "bad gateway" },
        { status: 502, body: "bad gateway" },
      ]);
      const client = new QdrantClient({ ...baseOpts, retries: 3 });
      await assert.rejects(() => client.request("GET", "/collections"), QdrantTransientError);
      assert.equal(mock.calls.length, 4); // initial + 3 retries
    });

    it("does not retry when retries=0", async () => {
      mock = installFetchMock([{ status: 503, body: "" }]);
      const client = new QdrantClient({ ...baseOpts, retries: 0 });
      await assert.rejects(() => client.request("GET", "/collections"), QdrantTransientError);
      assert.equal(mock.calls.length, 1);
    });
  });

  describe("rate limiting", () => {
    it("retries 429 then succeeds", async () => {
      mock = installFetchMock([
        { status: 429, body: "slow down", headers: { "retry-after": "0" } },
        { status: 200, body: "{}" },
      ]);
      const client = new QdrantClient(baseOpts);
      await client.request("POST", "/collections/foo/points");
      assert.equal(mock.calls.length, 2);
    });

    it("attaches retryAfterMs from Retry-After header", async () => {
      mock = installFetchMock([{ status: 429, body: "", headers: { "retry-after": "2" } }]);
      const client = new QdrantClient({ ...baseOpts, retries: 0 });
      try {
        await client.request("GET", "/collections");
        assert.fail("should have thrown");
      } catch (err) {
        assert.ok(err instanceof QdrantRateLimitError);
        assert.equal((err as QdrantRateLimitError).retryAfterMs, 2000);
      }
    });
  });

  describe("timeout", () => {
    it("aborted fetch surfaces as QdrantTransientError", async () => {
      const abortErr = new Error("The operation was aborted");
      abortErr.name = "TimeoutError";
      mock = installFetchMock([{ error: abortErr }, { error: abortErr }]);
      const client = new QdrantClient({ ...baseOpts, retries: 1, timeoutMs: 1 });
      await assert.rejects(() => client.request("GET", "/collections"), QdrantTransientError);
    });
  });

  describe("ensureCollection", () => {
    it("creates collection when GET returns 404", async () => {
      mock = installFetchMock([
        { status: 404, body: "not found" }, // GET /collections/foo
        { status: 200, body: "{}" }, // PUT /collections/foo
        { status: 200, body: "{}" }, // PUT index 1
      ]);
      const client = new QdrantClient(baseOpts);
      await client.ensureCollection(1024, [{ field_name: "category", field_schema: "keyword" }]);
      assert.equal(mock.calls.length, 3);
      assert.equal(mock.calls[1].init?.method, "PUT");
      const putBody = JSON.parse(mock.calls[1].init?.body as string);
      assert.deepEqual(putBody, { vectors: { size: 1024, distance: "Cosine" } });
    });

    it("skips creation when collection already exists", async () => {
      mock = installFetchMock([
        { status: 200, body: "{}" }, // GET succeeds
        { status: 200, body: "{}" }, // PUT index
      ]);
      const client = new QdrantClient(baseOpts);
      await client.ensureCollection(1024, [{ field_name: "category", field_schema: "keyword" }]);
      assert.equal(mock.calls.length, 2);
    });

    it("swallows index creation failures", async () => {
      mock = installFetchMock([
        { status: 200, body: "{}" }, // GET
        { status: 400, body: "index already exists" }, // PUT index — error swallowed
      ]);
      const client = new QdrantClient(baseOpts);
      await client.ensureCollection(1024, [{ field_name: "category", field_schema: "keyword" }]);
    });
  });

  describe("constructor validation", () => {
    it("rejects empty url", () => {
      assert.throws(() => new QdrantClient({ ...baseOpts, url: "" }), /url is required/);
    });
    it("rejects empty apiKey", () => {
      assert.throws(() => new QdrantClient({ ...baseOpts, apiKey: "" }), /apiKey is required/);
    });
    it("rejects empty collection", () => {
      assert.throws(() => new QdrantClient({ ...baseOpts, collection: "" }), /collection is required/);
    });
  });
});
