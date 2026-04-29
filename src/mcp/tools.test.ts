/**
 * Integration tests for the MCP tool handlers in tools.ts.
 *
 * tools.ts registers all tool handlers inside `registerTools(mcp)`. To exercise
 * them without a live MCP server we use a minimal fake McpServer that captures
 * each `tool(name, desc, schema, handler)` registration into a map. Tests then
 * invoke handlers directly with mocked fetch responses for Qdrant + embedding.
 *
 * Covers the data-integrity + recall surface:
 *   - memory_store: hash dedup, vector dedup, supersedes, relation insertion
 *   - memory_recall: filter passthrough, graph_depth=1 traversal, ranking
 *   - memory_entity: facts + relations aggregation with dedup
 *   - memory_forget: marks fact as superseded with reason
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { registerTools } from "./tools.js";
import {
  setQdrantUrl,
  setQdrantApiKey,
  setReady,
  setCollection,
  initEmbedding,
} from "./api.js";
import { THRESHOLD_DUPLICATE, THRESHOLD_RELATED } from "./taxonomy.js";

// ---------------------------------------------------------------------------
// Fake McpServer — captures `tool(name, desc, schema, handler)` registrations.
// ---------------------------------------------------------------------------

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

interface FakeServer {
  tool(name: string, desc: string, schema: unknown, handler: Handler): void;
}

function makeFakeServer(): { server: FakeServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server: FakeServer = {
    tool(name, _desc, _schema, handler) {
      handlers.set(name, handler);
    },
  };
  return { server, handlers };
}

// ---------------------------------------------------------------------------
// Fetch mock — script per-URL responses, record calls.
// ---------------------------------------------------------------------------

interface MockCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

type Responder = (call: MockCall) => unknown;

const realFetch = globalThis.fetch;
let calls: MockCall[];
let responders: Array<{ match: RegExp | string; respond: Responder }>;

function installFetchMock(): void {
  calls = [];
  responders = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const call: MockCall = { url, method: init?.method ?? "GET", body };
    calls.push(call);

    for (const r of responders) {
      const matches = typeof r.match === "string" ? url.includes(r.match) : r.match.test(url);
      if (matches) {
        const data = r.respond(call);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    // Default: empty success.
    return new Response(JSON.stringify({ status: "ok", result: null }), { status: 200 });
  }) as typeof fetch;
}

function on(match: RegExp | string, respond: Responder): void {
  responders.push({ match, respond });
}

function callsTo(match: RegExp | string): MockCall[] {
  return calls.filter((c) =>
    typeof match === "string" ? c.url.includes(match) : match.test(c.url),
  );
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let handlers: Map<string, Handler>;

async function invoke(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const h = handlers.get(name);
  if (!h) throw new Error(`Handler '${name}' not registered`);
  return h(args) as Promise<{ content: Array<{ type: string; text: string }> }>;
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("mcp/tools handlers", () => {
  before(() => {
    setQdrantUrl("https://qdrant.test:6333");
    setQdrantApiKey("test-key");
    setCollection("bikky-test");
    setReady(true);
    initEmbedding({
      provider: "ollama",
      baseUrl: "http://embed.test:11434",
      model: "test-model",
      dimensions: 4,
      apiKey: null,
    });

    const fake = makeFakeServer();
    // The real registerTools expects an McpServer; the only methods used are
    // `tool(...)` so the fake is structurally compatible at runtime.
    registerTools(fake.server as unknown as Parameters<typeof registerTools>[0]);
    handlers = fake.handlers;
  });

  beforeEach(() => {
    installFetchMock();
    // Always provide an embedding for any embed() call.
    on("/v1/embeddings", () => ({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }));
  });

  after(() => {
    globalThis.fetch = realFetch;
    setReady(false);
    setQdrantUrl(null);
    setQdrantApiKey(null);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tool registration sanity
  // ─────────────────────────────────────────────────────────────────────────

  it("registers all expected memory tools", () => {
    for (const name of [
      "memory_store",
      "memory_recall",
      "memory_entity",
      "memory_relations",
      "memory_forget",
      "memory_verify",
      "memory_review",
      "memory_heartbeat",
      "memory_mark_useful",
      "memory_report_outcome",
      "memory_session_summary",
      "memory_distill",
    ]) {
      assert.ok(handlers.has(name), `expected handler '${name}' to be registered`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // memory_store — dedup + insertion pipeline
  // ─────────────────────────────────────────────────────────────────────────

  describe("memory_store", () => {
    it("reinforces an exact content-hash match without re-embedding", async () => {
      on("/points/scroll", () => ({
        result: {
          points: [{
            id: "existing-1",
            payload: { content: "x", category: "engineering", reinforcement_count: 2 },
          }],
        },
      }));
      let setPayloadBody: Record<string, unknown> | null = null;
      on("/points/payload", (call) => {
        setPayloadBody = call.body;
        return { status: "ok" };
      });

      const result = await invoke("memory_store", {
        content: "qdrant runs on port 6333",
        category: "engineering",
        entities: ["qdrant"],
      });

      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.action, "reinforced");
      assert.equal(parsed.fact_id, "existing-1");
      assert.equal(parsed.reinforcement_count, 3);
      assert.deepEqual((setPayloadBody as unknown as { points: string[] }).points, ["existing-1"]);
      // Hash dedup hits before embedding.
      assert.equal(callsTo("/v1/embeddings").length, 0);
      // Hash dedup hits before semantic search.
      assert.equal(callsTo("/points/search").length, 0);
    });

    it("reinforces when semantic similarity exceeds THRESHOLD_DUPLICATE", async () => {
      on("/points/scroll", () => ({ result: { points: [] } })); // no hash hit
      on("/points/search", () => ({
        result: [{
          id: "near-dup",
          score: THRESHOLD_DUPLICATE + 0.01,
          payload: { content: "near", category: "engineering", reinforcement_count: 1 },
        }],
      }));
      on("/points/payload", () => ({ status: "ok" }));

      const result = await invoke("memory_store", {
        content: "qdrant listens on 6333",
        category: "engineering",
        entities: ["qdrant"],
      });

      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.action, "reinforced");
      assert.equal(parsed.fact_id, "near-dup");
      assert.equal(parsed.reinforcement_count, 2);
      assert.ok(parsed.similarity > THRESHOLD_DUPLICATE);
      // Should not insert a new point.
      assert.equal(callsTo(/\/points$/).length, 0);
    });

    it("inserts a new point when no duplicates are found", async () => {
      on("/points/scroll", () => ({ result: { points: [] } }));
      on("/points/search", () => ({ result: [] }));
      const upsertBodies: Record<string, unknown>[] = [];
      on(/\/points$/, (call) => {
        if (call.method === "PUT" && call.body) upsertBodies.push(call.body);
        return { status: "ok" };
      });

      const result = await invoke("memory_store", {
        content: "platform is on AWS",
        category: "engineering",
        entities: ["Platform"],
        importance: 0.7,
      });

      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.action, "inserted");
      assert.ok(parsed.fact_id, "should return a generated fact_id");
      assert.equal(upsertBodies.length, 1, "expected an upsert PUT to /points");
      const upsertBody = upsertBodies[0]!;
      const points = upsertBody.points;
      assert.ok(Array.isArray(points), "expected points array");
      const pt = points[0] as { payload: Record<string, unknown> };
      assert.equal(pt.payload.content, "platform is on AWS");
      assert.deepEqual(pt.payload.entities, ["platform"]); // lowercased
      assert.equal(pt.payload.reinforcement_count, 1);
      assert.equal(pt.payload.importance, 0.7);
      assert.ok(pt.payload.content_hash, "content_hash should be set");
      assert.equal(pt.payload.superseded_by, null);
    });

    it("redacts secret values before embedding and storage", async () => {
      on("/points/scroll", () => ({ result: { points: [] } }));
      on("/points/search", () => ({ result: [] }));
      const upsertBodies: Record<string, unknown>[] = [];
      on(/\/points$/, (call) => {
        if (call.method === "PUT" && call.body) upsertBodies.push(call.body);
        return { status: "ok" };
      });

      const result = await invoke("memory_store", {
        content: "platform deploy uses password=supersecretvalue",
        category: "engineering",
        entities: ["platform"],
      });

      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.action, "inserted");
      const embedCall = callsTo("/v1/embeddings")[0];
      assert.equal(embedCall?.body?.input, "platform deploy uses password=[REDACTED:secret]");
      assert.equal(upsertBodies.length, 1, "expected an upsert PUT to /points");
      const points = upsertBodies[0]!.points;
      assert.ok(Array.isArray(points), "expected points array");
      const pt = points[0] as { payload: Record<string, unknown> };
      assert.equal(pt.payload.content, "platform deploy uses password=[REDACTED:secret]");
      assert.deepEqual(pt.payload.redaction, {
        redacted: true,
        summary: "secret:1",
        matches: [{ type: "secret", count: 1 }],
      });
    });

    it("flags potential conflicts when similarity is in the related band with shared entities", async () => {
      on("/points/scroll", () => ({ result: { points: [] } }));
      const related = (THRESHOLD_RELATED + THRESHOLD_DUPLICATE) / 2;
      on("/points/search", () => ({
        result: [{
          id: "related-1",
          score: related,
          payload: {
            content: "old fact about platform",
            category: "engineering",
            entities: ["platform"],
          },
        }],
      }));
      on(/\/points$/, () => ({ status: "ok" }));

      const result = await invoke("memory_store", {
        content: "new fact about platform",
        category: "engineering",
        entities: ["platform"],
      });

      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.action, "inserted");
      assert.ok(Array.isArray(parsed.similar_facts) && parsed.similar_facts.length === 1);
      assert.ok(Array.isArray(parsed.potential_conflicts) && parsed.potential_conflicts.length === 1);
      assert.deepEqual(parsed.potential_conflicts[0].shared_entities, ["platform"]);
      assert.ok(parsed.conflict_hint, "conflict_hint should be present");
    });

    it("supersedes the prior fact when supersedes is provided", async () => {
      on("/points/scroll", () => ({ result: { points: [] } }));
      on("/points/search", () => ({ result: [] }));
      const payloadCalls: Array<Record<string, unknown>> = [];
      on("/points/payload", (call) => {
        payloadCalls.push(call.body as Record<string, unknown>);
        return { status: "ok" };
      });
      on(/\/points$/, (call) => {
        // POST without `points` key = qdrantGetPoints (lookup of supersedes target)
        const body = call.body as { points?: unknown; ids?: unknown };
        if (call.method === "POST" && !body.points) {
          return { result: [{ id: "old-fact-id", payload: { content: "old fact" } }] };
        }
        return { status: "ok" };
      });

      const result = await invoke("memory_store", {
        content: "qdrant now on 7000",
        category: "engineering",
        entities: ["qdrant"],
        supersedes: "old-fact-id",
      });

      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.action, "inserted");
      assert.equal(payloadCalls.length, 1);
      const supersedeCall = payloadCalls[0]! as { points: string[]; payload: Record<string, unknown> };
      assert.deepEqual(supersedeCall.points, ["old-fact-id"]);
      assert.equal(supersedeCall.payload.superseded_by, parsed.fact_id);
      assert.ok(supersedeCall.payload.superseded_at);
    });

    it("inserts a relation point alongside the fact when relation is provided", async () => {
      on("/points/scroll", () => ({ result: { points: [] } }));
      on("/points/search", () => ({ result: [] }));
      const upserts: Array<Record<string, unknown>> = [];
      on(/\/points$/, (call) => {
        if (call.method === "PUT") upserts.push(call.body as Record<string, unknown>);
        return { status: "ok" };
      });

      const result = await invoke("memory_store", {
        content: "saber owns platform",
        category: "human",
        entities: ["saber", "platform"],
        relation: { from: "Saber", type: "Owns", to: "Platform" },
      });

      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.action, "inserted");
      assert.ok(parsed.relation_id, "relation_id should be returned");
      // First upsert is the fact, second is the relation.
      assert.equal(upserts.length, 2);
      const relPt = (upserts[1] as { points: Array<{ payload: Record<string, unknown> }> }).points[0];
      assert.equal(relPt.payload.kind, "relation");
      assert.equal(relPt.payload.from_entity, "saber");
      assert.equal(relPt.payload.to_entity, "platform");
      assert.equal(relPt.payload.relation_type, "owns");
      assert.deepEqual(relPt.payload.entities, ["saber", "platform"]);
    });

    it("scopes relation redaction metadata to the relation payload", async () => {
      on("/points/scroll", () => ({ result: { points: [] } }));
      on("/points/search", () => ({ result: [] }));
      const upserts: Array<Record<string, unknown>> = [];
      on(/\/points$/, (call) => {
        if (call.method === "PUT") upserts.push(call.body as Record<string, unknown>);
        return { status: "ok" };
      });

      const result = await invoke("memory_store", {
        content: "saber owns platform",
        category: "human",
        entities: ["saber", "platform"],
        relation: { from: "api_key=relationsecret", type: "Owns", to: "Platform" },
      });

      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.action, "inserted");
      assert.deepEqual(parsed.redaction, {
        redacted: true,
        summary: "secret:1",
        matches: [{ type: "secret", count: 1 }],
      });
      assert.equal(upserts.length, 2);
      const factPt = (upserts[0] as { points: Array<{ payload: Record<string, unknown> }> }).points[0];
      const relPt = (upserts[1] as { points: Array<{ payload: Record<string, unknown> }> }).points[0];
      assert.equal(factPt.payload.redaction, undefined);
      assert.equal(relPt.payload.content, "api_key=[REDACTED:secret] Owns Platform");
      assert.deepEqual(relPt.payload.redaction, {
        redacted: true,
        summary: "secret:1",
        matches: [{ type: "secret", count: 1 }],
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // memory_recall — filter composition + graph_depth
  // ─────────────────────────────────────────────────────────────────────────

  describe("memory_recall", () => {
    it("returns 'No matching facts found' when search returns no results", async () => {
      on("/points/search", () => ({ result: [] }));
      const result = await invoke("memory_recall", { query: "nothing" });
      assert.match(textOf(result), /No matching facts found/);
    });

    it("returns parseable empty JSON when output_format=json and search has no results", async () => {
      on("/points/search", () => ({ result: [] }));
      const result = await invoke("memory_recall", { query: "nothing", output_format: "json" });
      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.query, "nothing");
      assert.equal(parsed.result_count, 0);
      assert.equal(parsed.related_count, 0);
      assert.deepEqual(parsed.results, []);
      assert.deepEqual(parsed.related, []);
    });

    it("passes category, domain, kind, entity, since, until, and metadata into the Qdrant filter", async () => {
      let searchBody: Record<string, unknown> | null = null;
      on("/points/search", (call) => {
        searchBody = call.body as Record<string, unknown>;
        return { result: [] };
      });

      await invoke("memory_recall", {
        query: "q",
        category: "engineering",
        domain: "software_engineering",
        kind: "fact",
        entity: "Qdrant",
        since: "2025-01-01T00:00:00Z",
        until: "2025-12-31T00:00:00Z",
        metadata_filter: { project: "bikky" },
      });

      assert.ok(searchBody);
      const filter = (searchBody as { filter: { must: Array<Record<string, unknown>> } }).filter;
      const must = filter.must;
      // excludeSuperseded → adds `is_null` condition into `must`.
      assert.ok(
        must.some((c) => (c as { is_null?: { key: string } }).is_null?.key === "superseded_by"),
        "expected an is_null:superseded_by condition in must",
      );
      // Field filters present in `must`.
      const keys = must.map((c) => (c.key as string) ?? "").filter(Boolean);
      for (const k of ["category", "domain", "kind", "entities", "created_at", "metadata.project"]) {
        assert.ok(keys.includes(k), `expected filter.must to contain key=${k}; got ${keys.join(",")}`);
      }
      // Entity is lowercased.
      const entityCond = must.find((c) => c.key === "entities") as { match: { value: string } };
      assert.equal(entityCond.match.value, "qdrant");
    });

    it("ranks results by combined score and slices to limit", async () => {
      // Three points: low score should win after combined weighting only if
      // freshness/reinforcement compensate; we just verify deterministic order
      // with three scores and limit=2.
      on("/points/search", () => ({
        result: [
          { id: "a", score: 0.6, payload: { content: "A", category: "engineering", entities: [], reinforcement_count: 1, confidence: 0.9, importance: 0.5, created_at: new Date().toISOString() } },
          { id: "b", score: 0.9, payload: { content: "B", category: "engineering", entities: [], reinforcement_count: 1, confidence: 0.9, importance: 0.5, created_at: new Date().toISOString() } },
          { id: "c", score: 0.75, payload: { content: "C", category: "engineering", entities: [], reinforcement_count: 1, confidence: 0.9, importance: 0.5, created_at: new Date().toISOString() } },
        ],
      }));

      const result = await invoke("memory_recall", { query: "q", limit: 2 });
      const text = textOf(result);
      const lines = text.split("\n").filter(Boolean);
      assert.equal(lines.length, 2, "should slice to limit=2");
      // 'B' has highest vector score → highest combined score → first.
      assert.match(lines[0]!, /\bB\b/);
      assert.match(lines[1]!, /\bC\b/);
    });

    it("returns structured JSON with stable fact fields when output_format=json", async () => {
      const now = new Date().toISOString();
      on("/points/search", () => ({
        result: [{
          id: "fact-json",
          score: 0.91,
          payload: {
            content: "JSON recall should be easy to parse",
            category: "engineering",
            domain: "software_engineering",
            kind: "fact",
            source: "user",
            entities: ["mcp", "recall"],
            confidence: 0.88,
            importance: 0.7,
            reinforcement_count: 2,
            verification_count: 1,
            useful_count: 3,
            not_useful_count: 0,
            metadata: { project: "bikky" },
            created_at: now,
            updated_at: now,
          },
        }],
      }));

      const result = await invoke("memory_recall", { query: "json recall", output_format: "json" });
      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.query, "json recall");
      assert.equal(parsed.requested_limit, 10);
      assert.equal(parsed.effective_limit, 10);
      assert.equal(parsed.limit_clamped, false);
      assert.equal(parsed.result_count, 1);
      assert.equal(parsed.related_count, 0);
      assert.equal(parsed.results.length, 1);
      assert.equal(parsed.results[0].id, "fact-json");
      assert.equal(parsed.results[0].content, "JSON recall should be easy to parse");
      assert.equal(parsed.results[0].category, "engineering");
      assert.deepEqual(parsed.results[0].entities, ["mcp", "recall"]);
      assert.equal(parsed.results[0].confidence, 0.88);
      assert.equal(parsed.results[0].score, 0.91);
      assert.deepEqual(parsed.related, []);
    });

    it("clamps large recall limits and reports the effective limit in JSON", async () => {
      const now = new Date().toISOString();
      on("/points/search", () => {
        return {
          result: Array.from({ length: 60 }, (_, i) => ({
            id: `fact-${i}`,
            score: 1 - i / 100,
            payload: {
              content: `fact ${i}`,
              category: "engineering",
              entities: [],
              confidence: 0.9,
              reinforcement_count: 1,
              created_at: now,
            },
          })),
        };
      });

      const result = await invoke("memory_recall", { query: "many", limit: 999, output_format: "json" });
      const parsed = JSON.parse(textOf(result));
      const searchBody = callsTo("/points/search")[0]?.body as Record<string, unknown> | undefined;
      assert.equal(searchBody?.limit, 100);
      assert.equal(parsed.requested_limit, 999);
      assert.equal(parsed.effective_limit, 50);
      assert.equal(parsed.max_limit, 50);
      assert.equal(parsed.limit_clamped, true);
      assert.equal(parsed.results.length, 50);
      assert.equal(parsed.result_count, 50);
    });

    it("appends 1-hop related facts when graph_depth=1", async () => {
      // Primary search returns one fact mentioning entity 'a'.
      on("/points/search", () => ({
        result: [{
          id: "p1",
          score: 0.9,
          payload: { content: "primary", category: "engineering", entities: ["a"], reinforcement_count: 1 },
        }],
      }));
      // Scroll mock dispatches based on filter shape inside the body.
      on("/points/scroll", (call) => {
        const body = call.body as { filter: { must: Array<Record<string, unknown>> } };
        const conditions = body.filter.must;
        const fromCond = conditions.find((c) => c.key === "from_entity") as { match: { value: string } } | undefined;
        const toCond = conditions.find((c) => c.key === "to_entity") as { match: { value: string } } | undefined;
        const entitiesCond = conditions.find((c) => c.key === "entities") as { match: { value: string } } | undefined;

        // graphTraversal queries: outgoing(from_entity=a), incoming(to_entity=a), then entities=b.
        if (fromCond?.match.value === "a") {
          return { result: { points: [{
            id: "rel1",
            payload: { content: "a -> b", category: "human", entities: ["a", "b"], from_entity: "a", to_entity: "b", relation_type: "uses", reinforcement_count: 1 },
          }] } };
        }
        if (toCond?.match.value === "a") {
          return { result: { points: [] } };
        }
        if (entitiesCond?.match.value === "b") {
          return { result: { points: [{
            id: "neighbor",
            payload: { content: "b is interesting", category: "engineering", entities: ["b"], reinforcement_count: 1 },
          }] } };
        }
        return { result: { points: [] } };
      });

      const result = await invoke("memory_recall", { query: "q", graph_depth: 1, limit: 5 });
      const text = textOf(result);
      assert.match(text, /primary/);
      assert.match(text, /Related \(1-hop\)/);
      assert.match(text, /b is interesting/);
    });

    it("separates primary and 1-hop related facts in JSON output", async () => {
      on("/points/search", () => ({
        result: [{
          id: "p1",
          score: 0.9,
          payload: {
            content: "primary",
            category: "engineering",
            entities: ["a"],
            confidence: 0.9,
            reinforcement_count: 1,
            created_at: new Date().toISOString(),
          },
        }],
      }));
      on("/points/scroll", (call) => {
        const body = call.body as { filter: { must: Array<Record<string, unknown>> } };
        const conditions = body.filter.must;
        const fromCond = conditions.find((c) => c.key === "from_entity") as { match: { value: string } } | undefined;
        const toCond = conditions.find((c) => c.key === "to_entity") as { match: { value: string } } | undefined;
        const entitiesCond = conditions.find((c) => c.key === "entities") as { match: { value: string } } | undefined;

        if (fromCond?.match.value === "a") {
          return { result: { points: [{
            id: "rel1",
            payload: { content: "a -> b", category: "human", entities: ["a", "b"], from_entity: "a", to_entity: "b", relation_type: "uses", reinforcement_count: 1 },
          }] } };
        }
        if (toCond?.match.value === "a") {
          return { result: { points: [] } };
        }
        if (entitiesCond?.match.value === "b") {
          return { result: { points: [{
            id: "neighbor",
            score: 0.7,
            payload: {
              content: "b is interesting",
              category: "engineering",
              entities: ["b"],
              confidence: 0.8,
              reinforcement_count: 1,
              created_at: new Date().toISOString(),
            },
          }] } };
        }
        return { result: { points: [] } };
      });

      const result = await invoke("memory_recall", { query: "q", graph_depth: 1, limit: 5, output_format: "json" });
      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.graph_depth, 1);
      assert.equal(parsed.result_count, 1);
      assert.equal(parsed.related_count, 1);
      assert.equal(parsed.results[0].id, "p1");
      assert.equal(parsed.related[0].id, "neighbor");
      assert.equal(parsed.related[0].content, "b is interesting");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // memory_entity — facts + relations aggregation
  // ─────────────────────────────────────────────────────────────────────────

  describe("memory_entity", () => {
    it("aggregates facts mentioning the entity plus from/to relations and dedups", async () => {
      on("/points/scroll", (call) => {
        const body = call.body as { filter: { must: Array<Record<string, unknown>> } };
        // Filter may contain workspace_id conditions first; scan all conditions for the entity-shaped one.
        const conds = body.filter.must as Array<{ key?: string; match?: { value?: string } }>;
        const entityCond = conds.find((c) => c.key === "entities" && c.match?.value === "platform");
        const fromCond = conds.find((c) => c.key === "from_entity" && c.match?.value === "platform");
        const toCond = conds.find((c) => c.key === "to_entity" && c.match?.value === "platform");

        if (entityCond) {
          return { result: { points: [
            { id: "f1", payload: { content: "platform fact", category: "engineering", entities: ["platform"], reinforcement_count: 1 } },
          ] } };
        }
        if (fromCond) {
          return { result: { points: [
            { id: "r1", payload: { content: "platform uses qdrant", category: "human", from_entity: "platform", to_entity: "qdrant", relation_type: "uses" } },
          ] } };
        }
        if (toCond) {
          // Same relation appears as 'to' lookup too — must be deduped by id.
          return { result: { points: [
            { id: "r1", payload: { content: "platform uses qdrant", category: "human", from_entity: "platform", to_entity: "qdrant", relation_type: "uses" } },
            { id: "r2", payload: { content: "saber owns platform", category: "human", from_entity: "saber", to_entity: "platform", relation_type: "owns" } },
          ] } };
        }
        return { result: { points: [] } };
      });

      const result = await invoke("memory_entity", { name: "Platform" });
      const text = textOf(result);
      assert.match(text, /Facts about Platform \(1\)/);
      assert.match(text, /platform fact/);
      assert.match(text, /Relations \(2\)/); // r1 deduped, r1+r2 unique
      assert.match(text, /platform --\[uses\]--> qdrant/);
      assert.match(text, /saber --\[owns\]--> platform/);
    });

    it("returns a friendly message when nothing is found", async () => {
      on("/points/scroll", () => ({ result: { points: [] } }));
      const result = await invoke("memory_entity", { name: "ghost" });
      assert.match(textOf(result), /No facts or relations found for 'ghost'/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // memory_forget — supersession marker
  // ─────────────────────────────────────────────────────────────────────────

  describe("memory_forget", () => {
    it("marks the fact as superseded with reason and timestamp", async () => {
      let body: Record<string, unknown> | null = null;
      on("/points/payload", (call) => {
        body = call.body as Record<string, unknown>;
        return { status: "ok" };
      });
      // memory_forget first calls qdrantGetPoints (POST /points with {ids,...}) for the workspace check.
      on(/\/points$/, (call) => {
        const callBody = call.body as { ids?: unknown };
        if (call.method === "POST" && callBody.ids) {
          return { result: [{ id: "victim", payload: { content: "to be forgotten" } }] };
        }
        return { status: "ok" };
      });

      const result = await invoke("memory_forget", { fact_id: "victim", reason: "outdated" });
      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.status, "forgotten");
      assert.equal(parsed.fact_id, "victim");
      assert.equal(parsed.reason, "outdated");

      assert.ok(body);
      const b = body as { points: string[]; payload: Record<string, unknown> };
      assert.deepEqual(b.points, ["victim"]);
      assert.equal(b.payload.superseded_by, "forgotten:outdated");
      assert.ok(b.payload.superseded_at);
      assert.ok(b.payload.updated_at);
    });

    it("returns a graceful error string when Qdrant rejects the call", async () => {
      // No matcher → default 200 OK; replace with explicit failure.
      responders = [];
      globalThis.fetch = (async () =>
        new Response("nope", { status: 500 })
      ) as typeof fetch;

      const result = await invoke("memory_forget", { fact_id: "x", reason: "y" });
      const text = textOf(result);
      assert.match(text, /^Error: /);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // memory_mark_useful
  // ─────────────────────────────────────────────────────────────────────────

  describe("memory_mark_useful", () => {
    it("bumps useful_count and writes a feedback_event telemetry row", async () => {
      const setPayloadCalls: Array<Record<string, unknown>> = [];
      let upsertedPayload: Record<string, unknown> | null = null;

      on(/\/points$/, (call) => {
        const b = call.body as { ids?: unknown; points?: unknown };
        if (call.method === "POST" && b.ids) {
          return { result: [{ id: "fact-1", payload: { content: "x", useful_count: 2 } }] };
        }
        if (call.method === "PUT" && b.points) {
          upsertedPayload = (b.points as Array<{ payload: Record<string, unknown> }>)[0].payload;
          return { status: "ok" };
        }
        return { status: "ok" };
      });
      on("/points/payload", (call) => {
        setPayloadCalls.push(call.body as Record<string, unknown>);
        return { status: "ok" };
      });

      const result = await invoke("memory_mark_useful", { fact_id: "fact-1", note: "saved a re-debug" });
      const parsed = JSON.parse(textOf(result));

      assert.equal(parsed.status, "marked_useful");
      assert.equal(parsed.fact_id, "fact-1");
      assert.equal(parsed.useful_count, 3);
      assert.ok(parsed.event_id);

      // Counter bump on the original fact.
      const counterBump = setPayloadCalls.find((b) => (b as { payload: Record<string, unknown> }).payload.useful_count !== undefined);
      assert.ok(counterBump, "expected a useful_count payload update");
      const bumpPayload = (counterBump as { payload: Record<string, unknown> }).payload;
      assert.equal(bumpPayload.useful_count, 3);
      assert.ok(bumpPayload.last_useful_at);

      // Telemetry row written.
      assert.ok(upsertedPayload, "expected a telemetry feedback_event upsert");
      const tp = upsertedPayload as Record<string, unknown>;
      assert.equal(tp.kind, "telemetry");
      assert.equal(tp.memory_subtype, "feedback_event");
      assert.equal(tp.target_fact_id, "fact-1");
      assert.equal(tp.feedback_kind, "useful");
      assert.match(String(tp.content), /saved a re-debug/);
    });

    it("returns not_found when the fact does not exist", async () => {
      on(/\/points$/, (call) => {
        const b = call.body as { ids?: unknown };
        if (call.method === "POST" && b.ids) return { result: [] };
        return { status: "ok" };
      });
      const result = await invoke("memory_mark_useful", { fact_id: "missing" });
      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.status, "not_found");
      assert.equal(parsed.fact_id, "missing");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // memory_report_outcome
  // ─────────────────────────────────────────────────────────────────────────

  describe("memory_report_outcome", () => {
    it("writes an outcome_event telemetry row carrying the outcome value", async () => {
      let upsertedPayload: Record<string, unknown> | null = null;

      on(/\/points$/, (call) => {
        const b = call.body as { ids?: unknown; points?: unknown };
        if (call.method === "POST" && b.ids) {
          return { result: [{ id: "fact-2", payload: { content: "y" } }] };
        }
        if (call.method === "PUT" && b.points) {
          upsertedPayload = (b.points as Array<{ payload: Record<string, unknown> }>)[0].payload;
          return { status: "ok" };
        }
        return { status: "ok" };
      });

      const result = await invoke("memory_report_outcome", {
        fact_id: "fact-2",
        outcome: "misleading",
        notes: "API moved in v2",
      });
      const parsed = JSON.parse(textOf(result));

      assert.equal(parsed.status, "outcome_recorded");
      assert.equal(parsed.outcome, "misleading");
      assert.ok(parsed.event_id);

      assert.ok(upsertedPayload);
      const tp = upsertedPayload as Record<string, unknown>;
      assert.equal(tp.kind, "telemetry");
      assert.equal(tp.memory_subtype, "outcome_event");
      assert.equal(tp.target_fact_id, "fact-2");
      assert.equal(tp.outcome, "misleading");
      // Negative outcomes are higher importance.
      assert.equal(tp.importance, 0.6);
      assert.match(String(tp.content), /API moved in v2/);
    });

    it("uses lower importance for non-negative outcomes", async () => {
      let upsertedPayload: Record<string, unknown> | null = null;
      on(/\/points$/, (call) => {
        const b = call.body as { ids?: unknown; points?: unknown };
        if (call.method === "POST" && b.ids) {
          return { result: [{ id: "fact-3", payload: { content: "z" } }] };
        }
        if (call.method === "PUT" && b.points) {
          upsertedPayload = (b.points as Array<{ payload: Record<string, unknown> }>)[0].payload;
          return { status: "ok" };
        }
        return { status: "ok" };
      });

      await invoke("memory_report_outcome", { fact_id: "fact-3", outcome: "useful" });
      const tp = upsertedPayload as unknown as Record<string, unknown>;
      assert.equal(tp.outcome, "useful");
      assert.equal(tp.importance, 0.3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // memory_session_summary
  // ─────────────────────────────────────────────────────────────────────────

  describe("memory_session_summary", () => {
    it("inserts a summary point pinned to kind=summary, memory_subtype=session_index", async () => {
      let upsertedPayload: Record<string, unknown> | null = null;
      on(/\/points$/, (call) => {
        const b = call.body as { points?: unknown };
        if (call.method === "PUT" && b.points) {
          upsertedPayload = (b.points as Array<{ payload: Record<string, unknown> }>)[0].payload;
          return { status: "ok" };
        }
        return { status: "ok" };
      });

      const result = await invoke("memory_session_summary", {
        content: "Built taxonomy slim and added 4 feedback tools.",
        entities: ["Bikky", "Taxonomy"],
        episode_id: "ep-1",
        workstream_key: "ws-bikky",
        repo: "bikky-dev/bikky",
      });
      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.status, "summary_stored");
      assert.ok(parsed.summary_id);

      assert.ok(upsertedPayload);
      const p = upsertedPayload as Record<string, unknown>;
      assert.equal(p.kind, "summary");
      assert.equal(p.memory_subtype, "session_index");
      assert.equal(p.source, "agent");
      assert.equal(p.episode_id, "ep-1");
      assert.equal(p.workstream_key, "ws-bikky");
      assert.equal(p.repo, "bikky-dev/bikky");
      assert.deepEqual(p.entities, ["bikky", "taxonomy"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // memory_distill
  // ─────────────────────────────────────────────────────────────────────────

  describe("memory_distill", () => {
    it("inserts a distilled point pinned to kind=distilled, memory_subtype=convention", async () => {
      let upsertedPayload: Record<string, unknown> | null = null;
      on(/\/points$/, (call) => {
        const b = call.body as { points?: unknown };
        if (call.method === "PUT" && b.points) {
          upsertedPayload = (b.points as Array<{ payload: Record<string, unknown> }>)[0].payload;
          return { status: "ok" };
        }
        return { status: "ok" };
      });

      const result = await invoke("memory_distill", {
        content: "Always create the relevant Qdrant payload index before adding a new filter.",
        entities: ["Qdrant", "filter"],
      });
      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.status, "distilled_stored");
      assert.ok(parsed.distilled_id);

      assert.ok(upsertedPayload);
      const p = upsertedPayload as Record<string, unknown>;
      assert.equal(p.kind, "distilled");
      assert.equal(p.memory_subtype, "convention");
      assert.equal(p.source, "agent");
      assert.deepEqual(p.entities, ["qdrant", "filter"]);
    });

    it("supersedes a prior distilled fact when supersedes is provided", async () => {
      const setPayloadCalls: Array<Record<string, unknown>> = [];
      on(/\/points$/, (call) => {
        const b = call.body as { ids?: unknown; points?: unknown };
        if (call.method === "POST" && b.ids) {
          return { result: [{ id: "old-1", payload: { content: "old convention" } }] };
        }
        return { status: "ok" };
      });
      on("/points/payload", (call) => {
        setPayloadCalls.push(call.body as Record<string, unknown>);
        return { status: "ok" };
      });

      const result = await invoke("memory_distill", {
        content: "Refined convention.",
        entities: ["x"],
        supersedes: "old-1",
      });
      const parsed = JSON.parse(textOf(result));
      assert.equal(parsed.status, "distilled_stored");
      assert.equal(parsed.supersedes, "old-1");

      const supersedeCall = setPayloadCalls.find((b) => {
        const points = (b as { points?: unknown }).points as string[] | undefined;
        return Array.isArray(points) && points.includes("old-1");
      });
      assert.ok(supersedeCall, "expected a supersede payload update on old-1");
      const sp = (supersedeCall as { payload: Record<string, unknown> }).payload;
      assert.equal(sp.superseded_by, parsed.distilled_id);
      assert.ok(sp.superseded_at);
    });
  });
});
