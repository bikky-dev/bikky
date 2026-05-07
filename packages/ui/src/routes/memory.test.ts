/**
 * Tests for the /api/memory/* Hono routes.
 * Mocks global fetch (Qdrant + embeddings) — exercises the routes via app.fetch().
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { Hono } from "hono";
import { memoryRoutes } from "./memory.js";

// Sandbox the bikky config dir to a tempdir so tests can never clobber the
// developer's real ~/.bikky/config.json (root cause of issue #130). BIKKY_HOME
// must be set before any import that touches the config module — including the
// dynamic import below.
const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-ui-memory-routes-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;
const CONFIG_PATH = path.join(TEST_BIKKY_HOME, "config.json");

const { _resetConfig } = await import("../lib/config.js");

const realFetch = globalThis.fetch;
const ENV_KEYS = ["QDRANT_URL", "QDRANT_API_KEY", "BIKKY_COLLECTION", "EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_BASE_URL", "OPENAI_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

interface QdrantCall { method: string; url: string; host: string; path: string; body: any }

/**
 * Install a fetch mock that pretends to be Qdrant + the embedding endpoint.
 * Pass `qdrantHandler` to react to Qdrant calls; returns the call log so tests
 * can assert on it.
 */
function installMock(opts: {
  qdrantHandler?: (call: QdrantCall) => unknown;
  embedding?: number[];
} = {}): { calls: QdrantCall[]; embedCalls: number; embedInputs: string[] } {
  const calls: QdrantCall[] = [];
  const state = { embedCalls: 0, embedInputs: [] as string[] };

  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;

    // Embedding endpoint
    if (url.includes("/v1/embeddings")) {
      state.embedCalls++;
      state.embedInputs.push(String(body?.input ?? ""));
      return new Response(JSON.stringify({
        data: [{ embedding: opts.embedding ?? [0.1, 0.2, 0.3] }],
      }), { status: 200 });
    }

    // Qdrant endpoint — keep host and path so multi-destination tests can
    // assert that requests were sent to the intended configured destination.
    const parsed = new URL(url);
    const call: QdrantCall = { method, url, host: parsed.host, path: parsed.pathname, body };
    calls.push(call);

    const result = opts.qdrantHandler ? opts.qdrantHandler(call) : { result: [] };
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;

  return new Proxy({ calls, embedCalls: state.embedCalls, embedInputs: state.embedInputs } as { calls: QdrantCall[]; embedCalls: number; embedInputs: string[] }, {
    get(_target, prop) {
      if (prop === "embedCalls") return state.embedCalls;
      if (prop === "embedInputs") return state.embedInputs;
      if (prop === "calls") return calls;
      return undefined;
    },
  });
}

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/memory", memoryRoutes);
  return app;
}

const sampleFact = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  payload: {
    content: "Bikky uses Qdrant",
    category: "engineering",
    domain: "software_engineering",
    kind: "fact",
    entities: ["bikky", "qdrant"],
    confidence: 0.9,
    superseded_by: null,
    superseded_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    content_hash: "h",
    reinforcement_count: 0,
    last_reinforced_at: "2024-01-01T00:00:00Z",
    ...overrides,
  },
});

const sampleEntityType = (name: string, type: string, overrides: Record<string, unknown> = {}) => ({
  id: `entity-type-${name}`,
  payload: {
    kind: "entity_type",
    entity_name: name,
    entity_type: type,
    entity_type_confidence: 0.82,
    entity_type_reasoning: `${name} is classified as ${type}`,
    classified_at: "2024-01-02T00:00:00Z",
    ...overrides,
  },
});

function writeMultiDestinationConfig(): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    collection: "fallback",
    destinations: [
      {
        name: "perso",
        qdrant_url: "https://perso.q.test",
        qdrant_api_key: "perso-key",
        collection: "perso_collection",
        default: true,
      },
      {
        name: "work",
        qdrant_url: "https://work.q.test",
        qdrant_api_key: "work-key",
        collection: "work_collection",
      },
    ],
    embedding: { provider: "ollama", model: "qwen", base_url: "http://embed.test", dimensions: 3 },
  }));
  _resetConfig();
}

describe("ui/routes/memory", () => {
  before(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    _resetConfig();
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      qdrant_url: "https://q.test",
      qdrant_api_key: "test-key",
      collection: "test",
      embedding: { provider: "ollama", model: "qwen", base_url: "http://embed.test", dimensions: 3 },
    }));
    _resetConfig();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe("GET /search", () => {
    it("returns 400 when q is missing", async () => {
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/memory/search"));
      assert.equal(res.status, 400);
    });

    it("falls back to keyword search when embedding provider is bedrock", async () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        qdrant_url: "https://q.test", qdrant_api_key: "k",
        embedding: { provider: "bedrock" },
      }));
      _resetConfig();
      const log = installMock({
        qdrantHandler: (c) => {
          if (c.path.endsWith("/points/scroll")) {
            return {
              result: {
                points: [
                  sampleFact({ content: "Bikky stores local memory facts", entities: ["needle-entity"] }),
                  sampleFact({ id: "22222222-2222-2222-2222-222222222222", content: "local other content", entities: ["qdrant"] }),
                ],
                next_page_offset: null,
              },
            };
          }
          return { result: [] };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/search?q=local%20needle-entity&category=engineering"));
      assert.equal(res.status, 200);
      const body = await res.json() as { results: any[]; count: number };
      assert.equal(body.count, 1);
      assert.equal(body.results[0].content, "Bikky stores local memory facts");
      assert.equal(log.embedCalls, 0);
      const scrollCall = log.calls.find((c) => c.path.endsWith("/points/scroll"));
      assert.ok(scrollCall);
      assert.ok(scrollCall.body.filter);
      assert.equal(log.calls.some((c) => c.path.endsWith("/points/search")), false);
    });

    it("embeds the query, calls Qdrant search, and returns formatted results", async () => {
      const log = installMock({
        qdrantHandler: () => ({ result: [{ ...sampleFact(), score: 0.99 }] }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/search?q=hello&category=engineering&memory_subtype=codebase_map&source=system&actor_id=agent-1&limit=5"));
      assert.equal(res.status, 200);
      const body = await res.json() as { results: any[]; count: number };
      assert.equal(body.count, 1);
      assert.equal(body.results[0].score, 0.99);
      assert.equal(body.results[0].content, "Bikky uses Qdrant");
      assert.equal(body.results[0].usefulness_score, null);
      assert.equal(body.results[0].usefulness_rated_count, 0);
      assert.equal(body.results[0].needs_review, false);

      const search = log.calls.find((c) => c.path.endsWith("/points/search"));
      assert.ok(search);
      assert.equal(search!.body.limit, 5);
      assert.deepEqual(search!.body.filter.must[0], {
        should: [
          { key: "origin.agent.type", match: { any: ["system", "daemon"] } },
          { key: "origin.interface", match: { any: ["system", "daemon"] } },
          { key: "source", match: { any: ["system", "daemon"] } },
        ],
      });
      assert.deepEqual(search!.body.filter.must[1], {
        should: [
          { key: "origin.user.id", match: { value: "agent-1" } },
          { key: "origin.agent.id", match: { value: "agent-1" } },
          { key: "actor_id", match: { value: "agent-1" } },
        ],
      });
      assert.deepEqual(search!.body.filter.should, [
        {
          key: "category",
          match: { any: ["engineering", "codebase", "infrastructure", "operations", "decisions", "observations"] },
        },
        {
          key: "memory_subtype",
          match: { value: "codebase_map" },
        },
      ]);
    });

    it("clamps limit to 100", async () => {
      const log = installMock({ qdrantHandler: () => ({ result: [] }) });
      const app = buildApp();

      await app.fetch(new Request("http://localhost/api/memory/search?q=hi&limit=9999"));
      const search = log.calls.find((c) => c.path.endsWith("/points/search"));
      assert.equal(search!.body.limit, 100);
    });

    it("fans out destination=all searches and tags merged results", async () => {
      writeMultiDestinationConfig();
      const log = installMock({
        qdrantHandler: (c) => ({
          result: c.host === "perso.q.test"
            ? [{ ...sampleFact({ content: "Personal Bikky memory" }), score: 0.8 }]
            : [{ ...sampleFact({ content: "Work Bikky memory" }), id: "22222222-2222-2222-2222-222222222222", score: 0.95 }],
        }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/search?q=bikky&destination=all"));

      assert.equal(res.status, 200);
      const body = await res.json() as { results: Array<{ content: string; _destination?: string }>; count: number };
      assert.equal(body.count, 2);
      assert.deepEqual(body.results.map((r) => r.content), ["Work Bikky memory", "Personal Bikky memory"]);
      assert.deepEqual(body.results.map((r) => r._destination), ["work", "perso"]);
      assert.deepEqual(
        log.calls.filter((c) => c.path.endsWith("/points/search")).map((c) => c.host).sort(),
        ["perso.q.test", "work.q.test"],
      );
    });

    it("sorts fetched search candidates by usefulness", async () => {
      installMock({
        qdrantHandler: () => ({
          result: [
            { ...sampleFact({ content: "Low usefulness", useful_count: 1, wrong_count: 2 }), score: 0.99 },
            { ...sampleFact({ content: "High usefulness", useful_count: 10, wrong_count: 2 }), id: "22222222-2222-2222-2222-222222222222", score: 0.7 },
          ],
        }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/search?q=bikky&sort=usefulness_desc"));

      assert.equal(res.status, 200);
      const body = await res.json() as { results: Array<{ content: string }> };
      assert.deepEqual(body.results.map((row) => row.content), ["High usefulness", "Low usefulness"]);
    });
  });

  describe("GET /browse", () => {
    it("calls scroll with order_by when sort=newest", async () => {
      const log = installMock({
        qdrantHandler: (c) => {
          if (c.path.endsWith("/points/count")) return { result: { count: 42 } };
          return { result: { points: [sampleFact()], next_page_offset: "abc" } };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/browse?sort=newest&limit=10"));
      assert.equal(res.status, 200);
      const body = await res.json() as { results: any[]; count: number; nextOffset: string };
      assert.equal(body.results.length, 1);
      assert.equal(body.count, 42);
      assert.equal(body.nextOffset, "abc");

      const scroll = log.calls.find((c) => c.path.endsWith("/points/scroll"));
      assert.deepEqual(scroll!.body.order_by, { key: "created_at", direction: "desc" });
    });

    it("computes usefulness fields for browse results", async () => {
      installMock({
        qdrantHandler: (c) => {
          if (c.path.endsWith("/points/count")) return { result: { count: 1 } };
          return { result: { points: [sampleFact({ useful_count: 3, misleading_count: 1 })], next_page_offset: null } };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/browse"));

      assert.equal(res.status, 200);
      const body = await res.json() as { results: Array<Record<string, unknown>> };
      assert.equal(body.results[0]!.useful_count, 3);
      assert.equal(body.results[0]!.misleading_count, 1);
      assert.equal(body.results[0]!.usefulness_rated_count, 4);
      assert.equal(typeof body.results[0]!.usefulness_score, "number");
      assert.equal(body.results[0]!.needs_review, true);
    });

    it("sorts and paginates a bounded usefulness browse scan", async () => {
      const log = installMock({
        qdrantHandler: () => ({
          result: {
            points: [
              sampleFact({ content: "Unrated", created_at: "2024-01-03T00:00:00Z" }),
              sampleFact({ content: "Low usefulness", useful_count: 1, wrong_count: 2, created_at: "2024-01-02T00:00:00Z" }),
              { ...sampleFact({ content: "High usefulness", useful_count: 10, wrong_count: 2, created_at: "2024-01-01T00:00:00Z" }), id: "22222222-2222-2222-2222-222222222222" },
            ],
            next_page_offset: null,
          },
        }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/browse?sort=usefulness_desc&usefulness=positive&limit=1"));

      assert.equal(res.status, 200);
      const body = await res.json() as { results: Array<{ content: string }>; count: number; nextOffset: number | null };
      assert.equal(body.count, 2);
      assert.equal(body.nextOffset, 1);
      assert.deepEqual(body.results.map((row) => row.content), ["High usefulness"]);

      const scroll = log.calls.find((c) => c.path.endsWith("/points/scroll"));
      assert.equal(scroll!.body.limit, 5000);
      assert.deepEqual(scroll!.body.order_by, { key: "created_at", direction: "desc" });
      assert.equal(log.calls.some((c) => c.path.endsWith("/points/count")), false);
    });

    it("filters usefulness browse results that need review", async () => {
      installMock({
        qdrantHandler: () => ({
          result: {
            points: [
              sampleFact({ content: "Clean useful", useful_count: 2 }),
              { ...sampleFact({ content: "Wrong memory", wrong_count: 1 }), id: "22222222-2222-2222-2222-222222222222" },
            ],
            next_page_offset: null,
          },
        }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/browse?usefulness=needs_review"));

      assert.equal(res.status, 200);
      const body = await res.json() as { results: Array<{ content: string; needs_review: boolean }>; count: number };
      assert.equal(body.count, 1);
      assert.deepEqual(body.results.map((row) => ({ content: row.content, needs_review: row.needs_review })), [
        { content: "Wrong memory", needs_review: true },
      ]);
    });

    it("forwards offset for pagination", async () => {
      const log = installMock({
        qdrantHandler: () => ({ result: { points: [], next_page_offset: null } }),
      });
      const app = buildApp();

      await app.fetch(new Request("http://localhost/api/memory/browse?offset=cursor-1"));
      const scroll = log.calls.find((c) => c.path.endsWith("/points/scroll"));
      assert.equal(scroll!.body.offset, "cursor-1");
    });

    it("forwards memory_subtype to Qdrant filters", async () => {
      const log = installMock({
        qdrantHandler: () => ({ result: { points: [], next_page_offset: null } }),
      });
      const app = buildApp();

      await app.fetch(new Request("http://localhost/api/memory/browse?memory_subtype=workstream"));
      const scroll = log.calls.find((c) => c.path.endsWith("/points/scroll"));
      assert.ok(scroll!.body.filter.must.some((cond: any) =>
        cond.key === "memory_subtype" && cond.match?.value === "workstream",
      ));
    });

    it("uses legacy category aliases for canonical category browse filters", async () => {
      const log = installMock({
        qdrantHandler: () => ({ result: { points: [], next_page_offset: null } }),
      });
      const app = buildApp();

      await app.fetch(new Request("http://localhost/api/memory/browse?category=engineering"));
      const scroll = log.calls.find((c) => c.path.endsWith("/points/scroll"));
      assert.ok(scroll);
      assert.deepEqual(scroll!.body.filter.must[0], {
        key: "category",
        match: { any: ["engineering", "codebase", "infrastructure", "operations", "decisions", "observations"] },
      });
    });

    it("uses legacy distilled aliases for convention subtype browse filters", async () => {
      const log = installMock({
        qdrantHandler: () => ({ result: { points: [], next_page_offset: null } }),
      });
      const app = buildApp();

      await app.fetch(new Request("http://localhost/api/memory/browse?memory_subtype=convention"));
      const scroll = log.calls.find((c) => c.path.endsWith("/points/scroll"));
      assert.ok(scroll);
      assert.deepEqual(scroll!.body.filter.must, []);
      assert.deepEqual(scroll!.body.filter.should, [
        { key: "memory_subtype", match: { value: "convention" } },
        { key: "kind", match: { value: "distilled" } },
      ]);
    });

    it("combines multiple category and subtype selections with OR", async () => {
      const log = installMock({
        qdrantHandler: () => ({ result: { points: [], next_page_offset: null } }),
      });
      const app = buildApp();

      await app.fetch(new Request("http://localhost/api/memory/browse?category=engineering,product&memory_subtype=codebase_map,convention&entity=bikky"));
      const scroll = log.calls.find((c) => c.path.endsWith("/points/scroll"));
      assert.ok(scroll);
      assert.deepEqual(scroll!.body.filter.must, [
        { key: "entities", match: { value: "bikky" } },
      ]);
      assert.deepEqual(scroll!.body.filter.should, [
        { key: "category", match: { any: ["engineering", "codebase", "infrastructure", "operations", "decisions", "observations"] } },
        { key: "category", match: { any: ["product", "product_domain", "projects"] } },
        { key: "memory_subtype", match: { value: "codebase_map" } },
        { key: "memory_subtype", match: { value: "convention" } },
        { key: "kind", match: { value: "distilled" } },
      ]);
    });

    it("targets a named destination when destination is provided", async () => {
      writeMultiDestinationConfig();
      const log = installMock({
        qdrantHandler: (c) => {
          if (c.path.endsWith("/points/count")) return { result: { count: 1 } };
          return { result: { points: [sampleFact()], next_page_offset: null } };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/browse?destination=work"));

      assert.equal(res.status, 200);
      assert.deepEqual([...new Set(log.calls.map((c) => c.host))], ["work.q.test"]);
      assert.deepEqual([...new Set(log.calls.map((c) => c.path.split("/")[2]))], ["work_collection"]);
    });

    it("fans out destination=all browse requests and suppresses cross-destination offset", async () => {
      writeMultiDestinationConfig();
      const log = installMock({
        qdrantHandler: (c) => {
          if (c.path.endsWith("/points/count")) return { result: { count: 1 } };
          return {
            result: {
              points: [
                c.host === "perso.q.test"
                  ? sampleFact({ content: "Personal fact" })
                  : { ...sampleFact({ content: "Work fact" }), id: "22222222-2222-2222-2222-222222222222" },
              ],
              next_page_offset: "ignored",
            },
          };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/browse?destination=all&offset=cursor-should-not-cross-destinations"));

      assert.equal(res.status, 200);
      const body = await res.json() as { results: Array<{ content: string; _destination?: string }>; count: number; nextOffset: string | null };
      assert.equal(body.count, 2);
      assert.equal(body.nextOffset, null);
      assert.deepEqual(body.results.map((r) => r._destination), ["perso", "work"]);
      assert.equal(log.calls.some((c) => c.body?.offset === "cursor-should-not-cross-destinations"), false);
      assert.deepEqual(
        log.calls.filter((c) => c.path.endsWith("/points/scroll")).map((c) => c.host).sort(),
        ["perso.q.test", "work.q.test"],
      );
    });
  });

  describe("GET /facts/:id", () => {
    it("returns 404 when not found", async () => {
      installMock({ qdrantHandler: () => ({ result: [] }) });
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/memory/facts/missing-id"));
      assert.equal(res.status, 404);
    });

    it("returns the formatted point when found", async () => {
      installMock({ qdrantHandler: () => ({ result: [sampleFact()] }) });
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/memory/facts/abc"));
      assert.equal(res.status, 200);
      const body = await res.json() as { id: string; content: string };
      assert.equal(body.content, "Bikky uses Qdrant");
    });
  });

  describe("PUT /facts/:id", () => {
    it("returns 404 when fact does not exist", async () => {
      installMock({ qdrantHandler: () => ({ result: [] }) });
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/memory/facts/missing", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "new" }),
      }));
      assert.equal(res.status, 404);
    });

    it("redacts content before setPayload and re-embedding when content changes", async () => {
      let getCount = 0;
      const log = installMock({
        qdrantHandler: (c) => {
          if (c.path.endsWith("/points") && c.method === "POST" && c.body?.ids) {
            // getPoints
            getCount++;
            return { result: [sampleFact()] };
          }
          return { result: {} };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/facts/id1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "updated password=supersecretvalue", entities: ["FOO", "Bar"] }),
      }));
      assert.equal(res.status, 200);

      const setPayload = log.calls.find((c) => c.path.endsWith("/points/payload"));
      assert.ok(setPayload, "expected setPayload call");
      assert.deepEqual(setPayload!.body.payload.entities, ["foo", "bar"]);
      assert.equal(setPayload!.body.payload.content, "updated password=[REDACTED:secret]");
      assert.deepEqual(setPayload!.body.payload.redaction, {
        redacted: true,
        summary: "secret:1",
        matches: [{ type: "secret", count: 1 }],
      });

      // Re-embed + upsert because content changed
      const upsert = log.calls.find((c) => c.method === "PUT" && c.path.endsWith("/points"));
      assert.ok(upsert, "expected upsert call after re-embed");
      assert.deepEqual(log.embedInputs, ["updated password=[REDACTED:secret]"]);
    });
  });

  describe("DELETE /facts/:id", () => {
    it("soft-deletes by setting superseded_by", async () => {
      const log = installMock({
        qdrantHandler: (c) => {
          if (c.method === "POST" && c.body?.ids) return { result: [sampleFact()] };
          return { result: {} };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/facts/id1", { method: "DELETE" }));
      assert.equal(res.status, 200);
      const setPayload = log.calls.find((c) => c.path.endsWith("/points/payload"));
      assert.equal(setPayload!.body.payload.superseded_by, "ui-deleted");
    });
  });

  describe("POST /facts", () => {
    it("returns 400 when required fields are missing", async () => {
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/memory/facts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hi" }),
      }));
      assert.equal(res.status, 400);
    });

    it("returns 501 when embedding is unavailable", async () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        qdrant_url: "https://q.test", qdrant_api_key: "k",
        embedding: { provider: "bedrock" },
      }));
      _resetConfig();
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/memory/facts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x", category: "c", entities: ["e"] }),
      }));
      assert.equal(res.status, 501);
    });

    it("creates the fact, redacts secrets in stored fields, lowercases entities, and returns 201", async () => {
      const log = installMock({ qdrantHandler: () => ({ result: {} }) });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/facts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "Hello password=supersecretvalue",
          category: "engineering",
          entities: ["FOO", "api_key=entitysecret"],
          from_entity: "token=fromsecret",
          relation_type: "Owns",
          to_entity: "Bar",
          metadata: { note: "manual add" },
        }),
      }));
      assert.equal(res.status, 201);

      const upsert = log.calls.find((c) => c.method === "PUT" && c.path.endsWith("/points"));
      assert.ok(upsert);
      const point = upsert!.body.points[0];
      assert.equal(point.payload.content, "Hello password=[REDACTED:secret]");
      assert.deepEqual(point.payload.entities, ["foo", "api_key=[redacted:secret]"]);
      assert.equal(point.payload.from_entity, "token=[REDACTED:secret]");
      assert.equal(point.payload.relation_type, "Owns");
      assert.equal(point.payload.to_entity, "Bar");
      assert.equal(point.payload.source, undefined);
      assert.equal(point.payload.actor_id, undefined);
      assert.equal(point.payload.origin.interface, "ui");
      assert.equal(point.payload.origin.operation.action, "create");
      assert.deepEqual(point.payload.metadata, { note: "manual add", created_via: "ui" });
      assert.equal(point.payload.kind, "fact");
      assert.equal(point.payload.domain, "software_engineering");
      assert.equal(typeof point.id, "string");
      assert.equal(typeof point.payload.content_hash, "string");
      assert.deepEqual(point.payload.redaction, {
        redacted: true,
        summary: "secret:3",
        matches: [{ type: "secret", count: 3 }],
      });
      assert.deepEqual(log.embedInputs, ["Hello password=[REDACTED:secret]"]);
    });
  });

  describe("GET /entities/:name", () => {
    it("aggregates facts and from/to relations", async () => {
      let scrollCount = 0;
      installMock({
        qdrantHandler: (c) => {
          if (c.path.endsWith("/points/scroll")) {
            scrollCount++;
            // First: facts. Second: from-relations. Third: to-relations. Fourth: entity type.
            const points = scrollCount === 1
              ? [sampleFact()]
              : scrollCount === 2
                ? [sampleFact({ from_entity: "alice", relation_type: "owns", to_entity: "bikky" })]
                : scrollCount === 3
                  ? [sampleFact({ from_entity: "bikky", relation_type: "uses", to_entity: "alice" })]
                  : [];
            return { result: { points, next_page_offset: null } };
          }
          return { result: [] };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/entities/Alice"));
      assert.equal(res.status, 200);
      const body = await res.json() as { entity: string; facts: any[]; relations: any[]; factCount: number; relationCount: number };
      assert.equal(body.entity, "alice");
      assert.equal(body.factCount, 1);
      assert.equal(body.relationCount, 2);
    });

    it("returns daemon-classified entity type metadata when present", async () => {
      let scrollCount = 0;
      installMock({
        qdrantHandler: (c) => {
          if (c.path.endsWith("/points/scroll")) {
            scrollCount++;
            const points = scrollCount === 1
              ? [sampleFact()]
              : scrollCount === 4
                ? [sampleEntityType("alice", "person")]
                : [];
            return { result: { points, next_page_offset: null } };
          }
          if (c.path.endsWith("/points/count")) return { result: { count: 1 } };
          return { result: [] };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/entities/Alice"));
      assert.equal(res.status, 200);
      const body = await res.json() as {
        entityType: string | null;
        entityTypeConfidence: number | null;
        entityTypeReasoning: string | null;
        entityTypeClassifiedAt: string | null;
      };
      assert.equal(body.entityType, "person");
      assert.equal(body.entityTypeConfidence, 0.82);
      assert.equal(body.entityTypeReasoning, "alice is classified as person");
      assert.equal(body.entityTypeClassifiedAt, "2024-01-02T00:00:00Z");
    });
  });

  describe("GET /entity-types", () => {
    it("returns a type map for requested entities", async () => {
      const log = installMock({
        qdrantHandler: (c) => {
          if (c.path.endsWith("/points/scroll")) {
            return {
              result: {
                points: [
                  sampleEntityType("bikky", "project"),
                  sampleEntityType("qdrant", "service"),
                ],
                next_page_offset: null,
              },
            };
          }
          return { result: [] };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/entity-types?names=BIKKY,qdrant"));
      assert.equal(res.status, 200);
      const body = await res.json() as { types: Record<string, string> };
      assert.deepEqual(body.types, { bikky: "project", qdrant: "service" });

      const scroll = log.calls.find((c) => c.path.endsWith("/points/scroll"));
      assert.ok(scroll);
      assert.deepEqual(scroll!.body.filter.must[1].match.any, ["bikky", "qdrant"]);
    });
  });

  describe("GET /shared", () => {
    it("returns 400 when a or b is missing", async () => {
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/memory/shared?a=foo"));
      assert.equal(res.status, 400);
    });

    it("returns intersection facts when both a and b are provided", async () => {
      installMock({
        qdrantHandler: () => ({ result: { points: [sampleFact()], next_page_offset: null } }),
      });
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/memory/shared?a=BIKKY&b=Qdrant"));
      assert.equal(res.status, 200);
      const body = await res.json() as { entityA: string; entityB: string; count: number };
      assert.equal(body.entityA, "bikky");
      assert.equal(body.entityB, "qdrant");
      assert.equal(body.count, 1);
    });
  });

  describe("GET /relations", () => {
    it("returns 400 when entity is missing", async () => {
      const app = buildApp();
      const res = await app.fetch(new Request("http://localhost/api/memory/relations"));
      assert.equal(res.status, 400);
    });

    it("dedupes results when direction=both", async () => {
      const dup = sampleFact({ from_entity: "alice", to_entity: "bob", relation_type: "knows" });
      installMock({
        qdrantHandler: () => ({ result: { points: [dup], next_page_offset: null } }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/relations?entity=alice"));
      assert.equal(res.status, 200);
      const body = await res.json() as { count: number; relations: any[] };
      assert.equal(body.count, 1, "should dedupe duplicate point ids across from/to scrolls");
    });
  });

  describe("GET /graph", () => {
    it("aggregates entity nodes and edges from facts", async () => {
      installMock({
        qdrantHandler: () => ({
          result: {
            points: [
              sampleFact({ entities: ["a", "b"], category: "engineering" }),
              sampleFact({ entities: ["b", "c"], category: "product" }),
            ],
            next_page_offset: null,
          },
        }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/graph"));
      assert.equal(res.status, 200);
      const body = await res.json() as { nodes: any[]; edges: any[]; factCount: number };
      assert.equal(body.factCount, 2);
      assert.equal(body.nodes.length, 3);
      assert.equal(body.edges.length, 2);
      const b = body.nodes.find((n) => n.id === "b");
      assert.equal(b.factCount, 2);
    });

    it("enforces node and edge budgets before returning graph data", async () => {
      installMock({
        qdrantHandler: () => ({
          result: {
            points: [
              sampleFact({ entities: ["a", "b"], category: "engineering" }),
              sampleFact({ entities: ["a", "c"], category: "product" }),
              sampleFact({ entities: ["a", "d"], category: "human" }),
            ],
            next_page_offset: null,
          },
        }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/graph?maxNodes=4&maxEdges=1&minWeight=1&refresh=true"));
      assert.equal(res.status, 200);
      const body = await res.json() as { nodes: any[]; edges: any[]; totalEdges: number; edgesPruned: number; maxNodes: number; maxEdges: number };
      assert.equal(body.maxNodes, 4);
      assert.equal(body.maxEdges, 1);
      assert.equal(body.nodes.length, 4);
      assert.equal(body.edges.length, 1);
      assert.equal(body.totalEdges, 3);
      assert.equal(body.edgesPruned, 2);
      assert.equal(body.edges[0].source, "a");
    });

    it("skips dense co-occurrence expansion while retaining entities", async () => {
      const denseEntities = Array.from({ length: 25 }, (_, i) => `entity-${i}`);
      installMock({
        qdrantHandler: () => ({
          result: {
            points: [sampleFact({ entities: denseEntities, category: "engineering" })],
            next_page_offset: null,
          },
        }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/graph?maxNodes=30&maxEdges=10&minWeight=1&refresh=true"));
      assert.equal(res.status, 200);
      const body = await res.json() as { nodes: any[]; edges: any[]; denseFactsSkipped: number; coOccurrenceEdgesSkipped: number };
      assert.equal(body.nodes.length, 25);
      assert.equal(body.edges.length, 0);
      assert.equal(body.denseFactsSkipped, 1);
      assert.equal(body.coOccurrenceEdgesSkipped, 300);
    });

    it("includes typed relation endpoints even when they are not listed as entities", async () => {
      installMock({
        qdrantHandler: () => ({
          result: {
            points: [sampleFact({ entities: [], from_entity: "alice", to_entity: "bob", relation_type: "owns" })],
            next_page_offset: null,
          },
        }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/graph?maxNodes=10&maxEdges=10&minWeight=1&refresh=true"));
      assert.equal(res.status, 200);
      const body = await res.json() as { nodes: any[]; edges: any[] };
      assert.ok(body.nodes.some((n) => n.id === "alice"));
      assert.ok(body.nodes.some((n) => n.id === "bob"));
      assert.equal(body.edges.length, 1);
      assert.equal(body.edges[0].type, "owns");
    });
  });

  describe("GET /stats", () => {
    it("returns total/active/superseded counts and ontology breakdowns", async () => {
      let pointsCount = 100;
      installMock({
        qdrantHandler: (c) => {
          if (c.path === "/collections/test") {
            return { result: { points_count: pointsCount, vectors_count: pointsCount } };
          }
          if (c.path.endsWith("/points/count")) {
            // Return a different count per filter to exercise the merge logic
            const must = c.body?.filter?.must ?? [];
            if (must.length === 0) return { result: { count: 90 } };
            return { result: { count: 10 } };
          }
          return { result: {} };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/stats"));
      assert.equal(res.status, 200);
      const body = await res.json() as {
        total: number;
        active: number;
        superseded: number;
        byCategory: Record<string, number>;
        byKind: Record<string, number>;
        bySubtype: Record<string, number>;
      };
      assert.equal(body.total, 100);
      assert.equal(body.active, 90);
      assert.equal(body.superseded, 10);
      assert.equal(body.byCategory.engineering, 10);
      assert.equal(body.byKind.fact, 10);
      assert.equal(body.bySubtype.codebase_map, 10);
    });

    it("scopes category and subtype counts to source and kind filters", async () => {
      const log = installMock({
        qdrantHandler: (c) => {
          if (c.path === "/collections/test") {
            return { result: { points_count: 100, vectors_count: 100 } };
          }
          if (c.path.endsWith("/points/count")) {
            const must = c.body?.filter?.must ?? [];
            if (must.some((cond: any) => cond.key === "category" && cond.match?.any?.includes("engineering"))) return { result: { count: 7 } };
            if (must.some((cond: any) => cond.key === "memory_subtype" && cond.match?.value === "codebase_map")) return { result: { count: 3 } };
            return { result: { count: 11 } };
          }
          return { result: {} };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/stats?kind=fact&source=system"));
      assert.equal(res.status, 200);
      const body = await res.json() as {
        active: number;
        byCategory: Record<string, number>;
        byKind: Record<string, number>;
        bySubtype: Record<string, number>;
      };
      assert.equal(body.active, 11);
      assert.equal(body.byCategory.engineering, 7);
      assert.equal(body.bySubtype.codebase_map, 3);
      assert.equal(body.byKind.fact, 11);

      const countCalls = log.calls.filter((c) => c.path.endsWith("/points/count"));
      const engineeringCount = countCalls.find((c) =>
        (c.body?.filter?.must ?? []).some((cond: any) => cond.key === "category" && cond.match?.any?.includes("engineering")),
      );
      assert.ok(engineeringCount);
      assert.deepEqual(engineeringCount!.body.filter.must, [
        { key: "category", match: { any: ["engineering", "codebase", "infrastructure", "operations", "decisions", "observations"] } },
        { key: "kind", match: { value: "fact" } },
        {
          should: [
            { key: "origin.agent.type", match: { any: ["system", "daemon"] } },
            { key: "origin.interface", match: { any: ["system", "daemon"] } },
            { key: "source", match: { any: ["system", "daemon"] } },
          ],
        },
      ]);

      const subtypeCount = countCalls.find((c) =>
        (c.body?.filter?.must ?? []).some((cond: any) => cond.key === "memory_subtype" && cond.match?.value === "codebase_map"),
      );
      assert.ok(subtypeCount);
      assert.deepEqual(subtypeCount!.body.filter.must, [
        { key: "kind", match: { value: "fact" } },
        { key: "memory_subtype", match: { value: "codebase_map" } },
        {
          should: [
            { key: "origin.agent.type", match: { any: ["system", "daemon"] } },
            { key: "origin.interface", match: { any: ["system", "daemon"] } },
            { key: "source", match: { any: ["system", "daemon"] } },
          ],
        },
      ]);
    });

    it("counts legacy distilled memories under the convention subtype", async () => {
      const log = installMock({
        qdrantHandler: (c) => {
          if (c.path === "/collections/test") {
            return { result: { points_count: 200, vectors_count: 200 } };
          }
          if (c.path.endsWith("/points/count")) {
            const must = c.body?.filter?.must ?? [];
            const should = c.body?.filter?.should ?? [];
            const isConventionSubtype = should.some((cond: any) => cond.key === "memory_subtype" && cond.match?.value === "convention") &&
              should.some((cond: any) => cond.key === "kind" && cond.match?.value === "distilled");
            if (isConventionSubtype) return { result: { count: 153 } };
            if (must.some((cond: any) => cond.key === "kind" && cond.match?.value === "distilled")) return { result: { count: 153 } };
            return { result: { count: 0 } };
          }
          return { result: {} };
        },
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/stats?kind=distilled"));
      assert.equal(res.status, 200);
      const body = await res.json() as {
        active: number;
        bySubtype: Record<string, number>;
      };
      assert.equal(body.active, 153);
      assert.equal(body.bySubtype.convention, 153);

      const conventionCount = log.calls
        .filter((c) => c.path.endsWith("/points/count"))
        .find((c) => (c.body?.filter?.should ?? []).some((cond: any) => cond.key === "memory_subtype" && cond.match?.value === "convention"));
      assert.ok(conventionCount);
      assert.deepEqual(conventionCount!.body.filter.must, [
        { key: "kind", match: { value: "distilled" } },
      ]);
      assert.deepEqual(conventionCount!.body.filter.should, [
        { key: "memory_subtype", match: { value: "convention" } },
        { key: "kind", match: { value: "distilled" } },
      ]);
    });
  });
});
