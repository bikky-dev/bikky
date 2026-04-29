/**
 * Tests for the /api/memory/* Hono routes.
 * Mocks global fetch (Qdrant + embeddings) — exercises the routes via app.fetch().
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { Hono } from "hono";
import { memoryRoutes } from "./memory.js";
import { CONFIG_PATH, _resetConfig } from "../lib/config.js";

const realFetch = globalThis.fetch;
const ENV_KEYS = ["QDRANT_URL", "QDRANT_API_KEY", "BIKKY_COLLECTION", "EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_BASE_URL", "OPENAI_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};
let savedConfig: string | null = null;
let configExisted = false;

interface QdrantCall { method: string; path: string; body: any }

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

    // Qdrant endpoint — extract path after the base URL
    const qdrantPath = url.replace("https://q.test", "");
    const call: QdrantCall = { method, path: qdrantPath, body };
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

describe("ui/routes/memory", () => {
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
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    fs.mkdirSync(CONFIG_PATH.replace(/\/[^/]+$/, ""), { recursive: true });
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

    it("returns 501 when embedding provider is bedrock", async () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        qdrant_url: "https://q.test", qdrant_api_key: "k",
        embedding: { provider: "bedrock" },
      }));
      _resetConfig();
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/search?q=hello"));
      assert.equal(res.status, 501);
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

      const search = log.calls.find((c) => c.path.endsWith("/points/search"));
      assert.ok(search);
      assert.equal(search!.body.limit, 5);
      assert.equal(search!.body.filter.must[0].match.value, "engineering");
      assert.deepEqual(search!.body.filter.must[1], {
        key: "memory_subtype",
        match: { value: "codebase_map" },
      });
      assert.deepEqual(search!.body.filter.must[2], {
        key: "source",
        match: { any: ["system", "daemon"] },
      });
      assert.deepEqual(search!.body.filter.must[3], {
        key: "actor_id",
        match: { value: "agent-1" },
      });
    });

    it("clamps limit to 100", async () => {
      const log = installMock({ qdrantHandler: () => ({ result: [] }) });
      const app = buildApp();

      await app.fetch(new Request("http://localhost/api/memory/search?q=hi&limit=9999"));
      const search = log.calls.find((c) => c.path.endsWith("/points/search"));
      assert.equal(search!.body.limit, 100);
    });
  });

  describe("GET /browse", () => {
    it("calls scroll with order_by when sort=newest", async () => {
      const log = installMock({
        qdrantHandler: () => ({ result: { points: [sampleFact()], next_page_offset: "abc" } }),
      });
      const app = buildApp();

      const res = await app.fetch(new Request("http://localhost/api/memory/browse?sort=newest&limit=10"));
      assert.equal(res.status, 200);
      const body = await res.json() as { results: any[]; nextOffset: string };
      assert.equal(body.nextOffset, "abc");

      const scroll = log.calls.find((c) => c.path.endsWith("/points/scroll"));
      assert.deepEqual(scroll!.body.order_by, { key: "created_at", direction: "desc" });
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
          actor_id: "agent-1",
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
      assert.equal(point.payload.source, "user");
      assert.equal(point.payload.actor_id, "agent-1");
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
  });
});
