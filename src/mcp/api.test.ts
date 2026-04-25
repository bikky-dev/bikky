/**
 * Tests for the MCP api helpers — Qdrant REST wrapper and ensureCollection.
 * Mocks global fetch so no real Qdrant is hit.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  qdrantReq,
  ensureCollection,
  getCollection,
  setCollection,
  setQdrantUrl,
  setQdrantApiKey,
  setReady,
  initEmbedding,
} from "./api.js";

interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const realFetch = globalThis.fetch;

function installMock(handler: (call: MockCall) => Response | Promise<Response>): MockCall[] {
  const calls: MockCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers as Record<string, string>) ?? {};
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const call: MockCall = { url, method: init?.method ?? "GET", headers, body };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

describe("mcp/api", () => {
  before(() => {
    setQdrantUrl("https://qdrant.test:6333");
    setQdrantApiKey("test-key");
    setCollection("bikky-test");
    initEmbedding({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "test-model",
      dimensions: 8,
      apiKey: null,
    });
  });

  after(() => {
    globalThis.fetch = realFetch;
    setQdrantUrl(null);
    setQdrantApiKey(null);
    setReady(false);
  });

  beforeEach(() => {
    globalThis.fetch = realFetch;
  });

  describe("collection setters", () => {
    it("getCollection round-trips via setCollection", () => {
      setCollection("foo");
      assert.equal(getCollection(), "foo");
      setCollection("bikky-test");
    });
  });

  describe("qdrantReq", () => {
    it("builds the URL, sends the api-key header, and serialises the body", async () => {
      const calls = installMock(() =>
        new Response(JSON.stringify({ result: { ok: true } }), { status: 200 }),
      );

      const result = await qdrantReq<{ result: { ok: boolean } }>("POST", "/foo", { x: 1 });

      assert.deepEqual(result, { result: { ok: true } });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, "https://qdrant.test:6333/foo");
      assert.equal(calls[0]!.method, "POST");
      assert.equal(calls[0]!.headers["api-key"], "test-key");
      assert.equal(calls[0]!.headers["Content-Type"], "application/json");
      assert.deepEqual(calls[0]!.body, { x: 1 });
    });

    it("omits the body for GET-style requests", async () => {
      const calls = installMock(() =>
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await qdrantReq("GET", "/x");
      assert.equal(calls[0]!.body, null);
    });

    it("throws with status + body when the response is not ok", async () => {
      installMock(() =>
        new Response("boom", { status: 500 }),
      );

      await assert.rejects(
        qdrantReq("GET", "/fail"),
        /Qdrant GET \/fail failed \(500\): boom/,
      );
    });
  });

  describe("ensureCollection", () => {
    it("does nothing if the collection already exists", async () => {
      const calls = installMock((call) => {
        if (call.method === "GET" && call.url.endsWith("/collections/bikky-test")) {
          return new Response(JSON.stringify({ result: { name: "bikky-test" } }), { status: 200 });
        }
        // Index creation calls
        if (call.url.endsWith("/index")) {
          return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
        }
        return new Response("unexpected", { status: 500 });
      });

      await ensureCollection([{ field_name: "category", field_schema: "keyword" }]);

      // 1 GET (existence check) + 1 PUT (index)
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.method, "GET");
      assert.equal(calls[1]!.method, "PUT");
      assert.ok(calls[1]!.url.endsWith("/index"));
    });

    it("creates the collection when GET returns 404", async () => {
      const calls = installMock((call) => {
        if (call.method === "GET" && call.url.endsWith("/collections/bikky-test")) {
          return new Response("not found (404)", { status: 404 });
        }
        return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
      });

      await ensureCollection([]);

      assert.equal(calls[0]!.method, "GET");
      assert.equal(calls[1]!.method, "PUT");
      assert.equal(calls[1]!.url, "https://qdrant.test:6333/collections/bikky-test");
      assert.ok(calls[1]!.body && typeof calls[1]!.body === "object");
    });

    it("propagates non-404 errors from the existence check", async () => {
      installMock((call) => {
        if (call.method === "GET") return new Response("auth failed", { status: 401 });
        return new Response("{}", { status: 200 });
      });

      await assert.rejects(ensureCollection([]), /401/);
    });

    it("swallows index creation errors with a warning", async () => {
      installMock((call) => {
        if (call.method === "GET") {
          return new Response(JSON.stringify({ result: { name: "bikky-test" } }), { status: 200 });
        }
        if (call.url.endsWith("/index")) {
          return new Response("index already exists", { status: 400 });
        }
        return new Response("{}", { status: 200 });
      });

      // Must NOT throw — index errors are warned and swallowed
      await ensureCollection([
        { field_name: "category", field_schema: "keyword" },
        { field_name: "domain", field_schema: "keyword" },
      ]);
    });
  });
});
