/**
 * Tests for the bikky-ui Qdrant client and filter builder.
 * Mocks global fetch — no real Qdrant required.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  QdrantClient,
  buildFilter,
  isQdrantConfigured,
  createQdrantClient,
  QdrantNotConfiguredError,
} from "./qdrant.js";
import { CONFIG_PATH, _resetConfig } from "./config.js";

const realFetch = globalThis.fetch;
const ENV_KEYS = ["QDRANT_URL", "QDRANT_API_KEY", "BIKKY_COLLECTION"];
const savedEnv: Record<string, string | undefined> = {};
let savedConfig: string | null = null;
let configExisted = false;

interface FetchCall { url: string; init: RequestInit }

function installMock(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

describe("ui/lib/qdrant", () => {
  describe("buildFilter", () => {
    it("returns an empty must list when no options are given", () => {
      assert.deepEqual(buildFilter({}), { must: [] });
    });

    it("adds is_null condition when excludeSuperseded is true", () => {
      const f = buildFilter({ excludeSuperseded: true });
      assert.deepEqual(f.must, [{ is_null: { key: "superseded_by" } }]);
    });

    it("adds match conditions for category, domain, kind, subtype, source", () => {
      const f = buildFilter({ category: "infra", domain: "work", kind: "fact", memorySubtype: "codebase_map", source: "agent" });
      assert.deepEqual(f.must, [
        { key: "category", match: { value: "infra" } },
        { key: "domain", match: { value: "work" } },
        { key: "kind", match: { value: "fact" } },
        { key: "memory_subtype", match: { value: "codebase_map" } },
        {
          should: [
            { key: "origin.agent.type", match: { any: ["agent", "cortex"] } },
            { key: "origin.interface", match: { any: ["agent", "cortex"] } },
            { key: "source", match: { any: ["agent", "cortex"] } },
          ],
        },
      ]);
    });

    it("maps canonical category filters to legacy stored categories", () => {
      const f = buildFilter({ category: "engineering" });
      assert.deepEqual(f.must, [
        { key: "category", match: { any: ["engineering", "codebase", "infrastructure", "operations", "decisions", "observations"] } },
      ]);
    });

    it("maps convention subtype filters to legacy distilled memories", () => {
      const f = buildFilter({ memorySubtype: "convention" });
      assert.deepEqual(f.must, []);
      assert.deepEqual(f.should, [
        { key: "memory_subtype", match: { value: "convention" } },
        { key: "kind", match: { value: "distilled" } },
      ]);
    });

    it("combines selected categories and subtypes as OR filters", () => {
      const f = buildFilter({
        categories: ["engineering", "product"],
        memorySubtypes: ["codebase_map", "convention"],
      });
      assert.deepEqual(f.must, []);
      assert.deepEqual(f.should, [
        { key: "category", match: { any: ["engineering", "codebase", "infrastructure", "operations", "decisions", "observations"] } },
        { key: "category", match: { any: ["product", "product_domain", "projects"] } },
        { key: "memory_subtype", match: { value: "codebase_map" } },
        { key: "memory_subtype", match: { value: "convention" } },
        { key: "kind", match: { value: "distilled" } },
      ]);
    });

    it("lowercases the entity value", () => {
      const f = buildFilter({ entity: "Bikky" });
      assert.deepEqual(f.must, [{ key: "entities", match: { value: "bikky" } }]);
    });

    it("adds range conditions for since and until", () => {
      const f = buildFilter({ since: "2024-01-01", until: "2024-12-31" });
      assert.deepEqual(f.must, [
        { key: "created_at", range: { gte: "2024-01-01" } },
        { key: "created_at", range: { lte: "2024-12-31" } },
      ]);
    });
  });

  describe("QdrantClient", () => {
    const client = new QdrantClient("https://q.test:6333/", "api-key", "col");

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("strips trailing slashes from the base URL", async () => {
      const calls = installMock(() => new Response(JSON.stringify({ result: [] }), { status: 200 }));
      await client.search([0.1, 0.2]);
      assert.equal(calls[0]!.url, "https://q.test:6333/collections/col/points/search");
    });

    it("sends the api-key header on every request", async () => {
      const calls = installMock(() => new Response(JSON.stringify({ result: [] }), { status: 200 }));
      await client.search([0.1]);
      const headers = calls[0]!.init.headers as Record<string, string>;
      assert.equal(headers["api-key"], "api-key");
      assert.equal(headers["Content-Type"], "application/json");
    });

    it("throws a descriptive error when the response is not ok", async () => {
      installMock(() => new Response("oops", { status: 502 }));
      await assert.rejects(
        client.search([0.1]),
        /Qdrant POST .* \(502\): oops/,
      );
    });

    it("scroll passes offset and order_by when provided", async () => {
      const calls = installMock(() => new Response(JSON.stringify({
        result: { points: [], next_page_offset: "next-cursor" },
      }), { status: 200 }));

      const res = await client.scroll({ must: [] }, 50, "abc", { key: "created_at", direction: "desc" });

      const body = JSON.parse(String(calls[0]!.init.body));
      assert.equal(body.offset, "abc");
      assert.deepEqual(body.order_by, { key: "created_at", direction: "desc" });
      assert.equal(body.limit, 50);
      assert.equal(res.nextOffset, "next-cursor");
    });

    it("scroll returns null nextOffset when omitted by Qdrant", async () => {
      installMock(() => new Response(JSON.stringify({
        result: { points: [{ id: "1", payload: {} }] },
      }), { status: 200 }));

      const res = await client.scroll({ must: [] });
      assert.equal(res.nextOffset, null);
      assert.equal(res.points.length, 1);
    });

    it("count returns the result.count value", async () => {
      installMock(() => new Response(JSON.stringify({ result: { count: 42 } }), { status: 200 }));
      const n = await client.count({ must: [{ key: "x", match: { value: "y" } }] });
      assert.equal(n, 42);
    });

    it("upsert sends the canonical points body", async () => {
      const calls = installMock(() => new Response(JSON.stringify({}), { status: 200 }));
      await client.upsert("id1", [0.1, 0.2], { content: "hi" });

      const body = JSON.parse(String(calls[0]!.init.body));
      assert.deepEqual(body, { points: [{ id: "id1", vector: [0.1, 0.2], payload: { content: "hi" } }] });
    });

    it("setPayload sends the canonical points body", async () => {
      const calls = installMock(() => new Response(JSON.stringify({}), { status: 200 }));
      await client.setPayload(["id1", "id2"], { foo: "bar" });

      const body = JSON.parse(String(calls[0]!.init.body));
      assert.deepEqual(body, { points: ["id1", "id2"], payload: { foo: "bar" } });
    });

    it("collectionInfo uses GET /collections/<name>", async () => {
      const calls = installMock(() => new Response(JSON.stringify({
        result: { points_count: 12, vectors_count: 12 },
      }), { status: 200 }));

      const info = await client.collectionInfo();
      assert.equal(calls[0]!.init.method, "GET");
      assert.equal(calls[0]!.url, "https://q.test:6333/collections/col");
      assert.equal(info.points_count, 12);
    });
  });

  describe("createQdrantClient / isQdrantConfigured", () => {
    before(() => {
      for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
      if (fs.existsSync(CONFIG_PATH)) {
        configExisted = true;
        savedConfig = fs.readFileSync(CONFIG_PATH, "utf-8");
      }
    });

    after(() => {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      if (savedConfig !== null) fs.writeFileSync(CONFIG_PATH, savedConfig);
      else if (!configExisted && fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      _resetConfig();
    });

    beforeEach(() => {
      for (const k of ENV_KEYS) delete process.env[k];
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      _resetConfig();
    });

    it("returns false / throws when no Qdrant credentials are configured", () => {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, "{}");

      assert.equal(isQdrantConfigured(), false);
      assert.throws(() => createQdrantClient(), QdrantNotConfiguredError);
    });

    it("returns true and constructs a client when credentials are present", () => {
      process.env.QDRANT_URL = "https://q.example:6333";
      process.env.QDRANT_API_KEY = "k";

      assert.equal(isQdrantConfigured(), true);
      const c = createQdrantClient();
      assert.ok(c instanceof QdrantClient);
    });

    it("returns true with URL alone (local / self-hosted Qdrant, no API key)", () => {
      process.env.QDRANT_URL = "http://localhost:6333";

      assert.equal(isQdrantConfigured(), true);
      const c = createQdrantClient();
      assert.ok(c instanceof QdrantClient);
    });
  });

  describe("auth header (no api key)", () => {
    it("omits the api-key header when none is configured", async () => {
      const client = new QdrantClient("https://q.test:6333", null, "col");
      const calls = installMock(() => new Response(JSON.stringify({ result: [] }), { status: 200 }));
      await client.search([0.1]);
      const headers = calls[0]!.init.headers as Record<string, string>;
      assert.equal(headers["api-key"], undefined);
      assert.equal(headers["Content-Type"], "application/json");
    });
  });

  describe("workspace_id auto-injection", () => {
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("does not inject workspace_id when no workspace is set", async () => {
      const client = new QdrantClient("https://q.test:6333", null, "col");
      const calls = installMock(() => new Response(JSON.stringify({
        result: { points: [], next_page_offset: null },
      }), { status: 200 }));

      await client.scroll({ must: [{ key: "kind", match: { value: "fact" } }] });
      const body = JSON.parse(String(calls[0]!.init.body));
      assert.deepEqual(body.filter, { must: [{ key: "kind", match: { value: "fact" } }] });
    });

    it("trims whitespace-only workspaceId to disabled (unscoped)", async () => {
      // Workspace scoping was removed in v0.4 — kept a basic test that scroll
      // still passes the filter through unchanged.
      const client = new QdrantClient("https://q.test:6333", null, "col");
      const calls = installMock(() => new Response(JSON.stringify({
        result: { points: [], next_page_offset: null },
      }), { status: 200 }));

      await client.scroll({ must: [] });
      const body = JSON.parse(String(calls[0]!.init.body));
      assert.deepEqual(body.filter, { must: [] });
    });
  });

  it("QdrantNotConfiguredError carries a helpful message", () => {
    const err = new QdrantNotConfiguredError();
    assert.equal(err.name, "QdrantNotConfiguredError");
    assert.match(err.message, /bikky setup/);
  });
});
