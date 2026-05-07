import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-mcp-tools-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const { registerTools } = await import("./tools.js");
const {
  CONFIG_DEFAULTS,
  resetConfig,
  saveConfig,
} = await import("../config.js");
const {
  initEmbedding,
  rebuildPool,
  setReady,
  setSetupError,
} = await import("./api.js");

const realFetch = globalThis.fetch;

type ToolHandler = (args?: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

interface FetchCall {
  destination: string | null;
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function collectTools(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  registerTools({
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer);
  return handlers;
}

function parseToolJson(result: Awaited<ReturnType<ToolHandler>>): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function destinationList(value: "routed" | "all" | string[]): string {
  return Array.isArray(value) ? value.join(",") : value;
}

function configureDestinations(): void {
  saveConfig({
    ...CONFIG_DEFAULTS,
    embedding: {
      ...CONFIG_DEFAULTS.embedding,
      provider: "ollama",
      base_url: "http://embed.test",
      model: "qwen-test",
      dimensions: 3,
      timeout_ms: 100,
      retries: 0,
    },
    qdrant_client: {
      ...CONFIG_DEFAULTS.qdrant_client,
      timeout_ms: 100,
      retries: 0,
    },
    destinations: [
      {
        name: "perso",
        description: "Personal memories",
        qdrant_url: "https://perso.q.test",
        qdrant_api_key: "perso-key",
        collection: "perso_collection",
        default: true,
      },
      {
        name: "work",
        description: "Work memories",
        qdrant_url: "https://work.q.test",
        qdrant_api_key: "work-key",
        collection: "work_collection",
      },
    ],
    default_search_scope: "all",
    search_scopes: [
      { name: "personal-only", destinations: ["perso"], description: "Only personal memories" },
    ],
  });
  resetConfig();
  initEmbedding({
    provider: "ollama",
    baseUrl: "http://embed.test",
    model: "qwen-test",
    dimensions: 3,
    timeoutMs: 100,
    retries: 0,
  });
  rebuildPool();
}

function point(id: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    payload: {
      content: "Bikky stores memories in Qdrant.",
      category: "engineering",
      entities: ["bikky"],
      confidence: 0.9,
      reinforcement_count: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      last_reinforced_at: "2026-01-01T00:00:00.000Z",
      ...payload,
    },
  };
}

function installStorageMock(opts: {
  scrollPoints?: Record<string, unknown>[];
  searchResults?: Record<string, unknown>[];
  searchResultsByDestination?: Record<string, Record<string, unknown>[]>;
  pointsByDestination?: Record<string, Record<string, Record<string, unknown>>>;
} = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  const destinationForUrl = (url: string): string | null => {
    if (url.startsWith("https://perso.q.test/")) return "perso";
    if (url.startsWith("https://work.q.test/")) return "work";
    return null;
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const destination = destinationForUrl(url);
    calls.push({ destination, url, method, body });

    if (url === "http://embed.test/v1/embeddings") {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
    }

    if (url.endsWith("/points/scroll")) {
      return new Response(JSON.stringify({ result: { points: opts.scrollPoints ?? [] } }), { status: 200 });
    }

    if (url.endsWith("/points/search")) {
      return new Response(JSON.stringify({
        result: (destination ? opts.searchResultsByDestination?.[destination] : undefined) ?? opts.searchResults ?? [],
      }), { status: 200 });
    }

    if (method === "POST" && url.endsWith("/points")) {
      const ids = Array.isArray(body?.ids) ? body.ids.map(String) : [];
      const destPoints = destination ? opts.pointsByDestination?.[destination] ?? {} : {};
      const result = ids.map((id) => destPoints[id]).filter(Boolean);
      return new Response(JSON.stringify({ result }), { status: 200 });
    }

    if (method === "POST" && url.endsWith("/points/payload")) {
      return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 });
    }

    if (method === "PUT" && url.endsWith("/points")) {
      return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  return calls;
}

describe("mcp/tools", () => {
  before(() => {
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
  });

  after(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    configureDestinations();
    setSetupError(null);
    setReady(true);
    globalThis.fetch = realFetch;
  });

  it("registers destination-aware memory tools", () => {
    const handlers = collectTools();

    for (const name of [
      "get_setup_status",
      "memory_search_scopes",
      "memory_store",
      "memory_recall",
      "memory_entity",
      "memory_relations",
    ]) {
      assert.equal(handlers.has(name), true, `expected ${name} to be registered`);
    }
  });

  it("reports setup_required before write tools touch storage", async () => {
    setReady(false);
    setSetupError("embedding unavailable");
    const handlers = collectTools();

    const result = await handlers.get("memory_store")!({
      content: "Bikky stores memories in Qdrant.",
      category: "engineering",
      entities: ["bikky"],
      domain: "software_engineering",
      kind: "fact",
      source: "agent",
      confidence: 0.9,
    });

    const body = parseToolJson(result);
    assert.equal(body.status, "setup_required");
    assert.equal(body.ready, false);
    assert.equal(body.setup_error, "embedding unavailable");
  });

  it("lists built-in, destination, and configured search scopes", async () => {
    const handlers = collectTools();

    const result = await handlers.get("memory_search_scopes")!();
    const body = parseToolJson(result) as {
      default_search_scope: string;
      scopes: Array<{ name: string; destinations: "routed" | "all" | string[] }>;
    };

    assert.equal(body.default_search_scope, "all");
    assert.ok(body.scopes.some((scope) => scope.name === "routed"));
    assert.ok(body.scopes.some((scope) => scope.name === "all" && scope.destinations === "all"));
    assert.ok(body.scopes.some((scope) => scope.name === "perso" && destinationList(scope.destinations) === "perso"));
    assert.ok(body.scopes.some((scope) => scope.name === "personal-only" && destinationList(scope.destinations) === "perso"));
  });

  it("rejects ambiguous recall destination and search_scope before embedding", async () => {
    const handlers = collectTools();

    const result = await handlers.get("memory_recall")!({
      query: "bikky routing",
      destination: "perso",
      search_scope: "all",
      limit: 5,
      graph_depth: 0,
      output_format: "json",
    });

    const body = parseToolJson(result);
    assert.equal(result.isError, true);
    assert.equal(body.status, "ambiguous_search_scope");
  });

  it("validates memory_subtype against kind before storing", async () => {
    const handlers = collectTools();

    const result = await handlers.get("memory_store")!({
      content: "Bikky stores memories in Qdrant.",
      category: "engineering",
      entities: ["bikky"],
      domain: "software_engineering",
      kind: "fact",
      memory_subtype: "session_index",
      source: "agent",
      confidence: 0.9,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /memory_subtype/i);
  });

  it("stores a new memory in the routed destination with redacted secrets", async () => {
    const calls = installStorageMock();
    const handlers = collectTools();

    const result = await handlers.get("memory_store")!({
      content: "Bikky token sk-abcdefghijklmnopqrstuvwxyz should be redacted.",
      category: "engineering",
      entities: ["bikky"],
      domain: "software_engineering",
      kind: "fact",
      source: "agent",
      confidence: 0.9,
    });

    const body = parseToolJson(result);
    assert.equal(body.action, "inserted");
    assert.equal(body.destination, "perso");
    assert.equal((body.redaction as Record<string, unknown>).redacted, true);

    const upsert = calls.find((call) => call.method === "PUT" && call.url.endsWith("/points"));
    assert.ok(upsert);
    assert.equal(upsert.destination, "perso");
    const points = upsert.body?.points as Array<{ payload: Record<string, unknown> }>;
    assert.match(String(points[0]!.payload.content), /\[REDACTED:secret\]/);
    assert.deepEqual(points[0]!.payload.entities, ["bikky"]);
    assert.equal((points[0]!.payload.redaction as Record<string, unknown>).redacted, true);
  });

  it("reinforces exact memory_store matches without embedding", async () => {
    const calls = installStorageMock({
      scrollPoints: [point("existing-fact", { reinforcement_count: 2 })],
    });
    const handlers = collectTools();

    const result = await handlers.get("memory_store")!({
      content: "Bikky stores memories in Qdrant.",
      category: "engineering",
      entities: ["bikky"],
      domain: "software_engineering",
      kind: "fact",
      source: "agent",
      confidence: 0.9,
    });

    const body = parseToolJson(result);
    assert.equal(body.action, "reinforced");
    assert.equal(body.fact_id, "existing-fact");
    assert.equal(body.reinforcement_count, 3);
    assert.equal(calls.some((call) => call.url === "http://embed.test/v1/embeddings"), false);

    const payloadUpdate = calls.find((call) => call.url.endsWith("/points/payload"));
    assert.ok(payloadUpdate);
    assert.equal(payloadUpdate.destination, "perso");
    assert.deepEqual(payloadUpdate.body?.points, ["existing-fact"]);
  });

  it("supersedes an existing fact before inserting the replacement", async () => {
    const calls = installStorageMock({
      pointsByDestination: {
        perso: {
          "old-fact": point("old-fact"),
        },
      },
    });
    const handlers = collectTools();

    const result = await handlers.get("memory_store")!({
      content: "Bikky now stores memories in routed Qdrant destinations.",
      category: "engineering",
      entities: ["bikky"],
      domain: "software_engineering",
      kind: "fact",
      source: "agent",
      confidence: 0.9,
      supersedes: "old-fact",
    });

    const body = parseToolJson(result);
    assert.equal(body.action, "inserted");
    assert.equal(body.destination, "perso");

    const getOld = calls.find((call) => call.method === "POST" && call.url.endsWith("/points") && call.body?.ids);
    assert.ok(getOld);
    assert.equal(getOld.destination, "perso");
    assert.deepEqual(getOld.body?.ids, ["old-fact"]);

    const supersede = calls.find((call) => call.url.endsWith("/points/payload"));
    assert.ok(supersede);
    assert.equal(supersede.destination, "perso");
    assert.deepEqual(supersede.body?.points, ["old-fact"]);
    assert.equal(typeof (supersede.body?.payload as Record<string, unknown>).superseded_by, "string");
  });

  it("stores typed relation points alongside memory_store facts", async () => {
    const calls = installStorageMock();
    const handlers = collectTools();

    const result = await handlers.get("memory_store")!({
      content: "Bikky uses Qdrant for memory storage.",
      category: "engineering",
      entities: ["bikky", "qdrant"],
      domain: "software_engineering",
      kind: "fact",
      source: "agent",
      confidence: 0.9,
      relation: { from: "bikky", type: "uses", to: "qdrant" },
    });

    const body = parseToolJson(result);
    assert.equal(body.action, "inserted");
    assert.equal(typeof body.relation_id, "string");
    assert.equal(calls.filter((call) => call.url === "http://embed.test/v1/embeddings").length, 2);

    const upserts = calls.filter((call) => call.method === "PUT" && call.url.endsWith("/points"));
    assert.equal(upserts.length, 2);
    const relationPayload = ((upserts[1]!.body?.points as Array<{ payload: Record<string, unknown> }>)[0]!.payload);
    assert.equal(relationPayload.kind, "relation");
    assert.equal(relationPayload.from_entity, "bikky");
    assert.equal(relationPayload.relation_type, "uses");
    assert.equal(relationPayload.to_entity, "qdrant");
  });

  it("locates the owning destination before forgetting a fact", async () => {
    const calls = installStorageMock({
      pointsByDestination: {
        work: {
          "work-fact": point("work-fact"),
        },
      },
    });
    const handlers = collectTools();

    const result = await handlers.get("memory_forget")!({
      fact_id: "work-fact",
      reason: "contains token ghp_abcdefghijklmnopqrstuvwxyz",
    });

    const body = parseToolJson(result);
    assert.equal(body.status, "forgotten");
    assert.equal(body.destination, "work");
    assert.match(String(body.reason), /\[REDACTED:secret\]/);

    const getCalls = calls.filter((call) => call.method === "POST" && call.url.endsWith("/points") && call.body?.ids);
    assert.deepEqual(getCalls.map((call) => call.destination), ["perso", "work"]);
    const payloadUpdate = calls.find((call) => call.url.endsWith("/points/payload"));
    assert.ok(payloadUpdate);
    assert.equal(payloadUpdate.destination, "work");
    assert.equal((payloadUpdate.body?.payload as Record<string, unknown>).is_bad_exemplar, true);
  });

  it("locates the owning destination before verifying a fact", async () => {
    const calls = installStorageMock({
      pointsByDestination: {
        work: {
          "work-fact": point("work-fact", { verification_count: 4 }),
        },
      },
    });
    const handlers = collectTools();

    const result = await handlers.get("memory_verify")!({ fact_id: "work-fact" });

    const body = parseToolJson(result);
    assert.equal(body.status, "verified");
    assert.equal(body.destination, "work");
    assert.equal(body.verification_count, 5);

    const payloadUpdate = calls.find((call) => call.url.endsWith("/points/payload"));
    assert.ok(payloadUpdate);
    assert.equal(payloadUpdate.destination, "work");
    assert.equal((payloadUpdate.body?.payload as Record<string, unknown>).verification_count, 5);
  });

  it("writes recall telemetry and updates recall counters in the result destination", async () => {
    const calls = installStorageMock({
      searchResults: [
        point("work-fact", {
          recall_count: 1,
          updated_at: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });
    const handlers = collectTools();

    const result = await handlers.get("memory_recall")!({
      query: "where does bikky store memories?",
      search_scope: "work",
      output_format: "json",
    });

    const body = parseToolJson(result);
    assert.equal(body.result_count, 1);

    const payloadUpdate = calls.find((call) => call.method === "POST" && call.url.endsWith("/points/payload"));
    assert.ok(payloadUpdate);
    assert.equal(payloadUpdate.destination, "work");
    assert.deepEqual(payloadUpdate.body?.points, ["work-fact"]);
    assert.equal((payloadUpdate.body?.payload as Record<string, unknown>).recall_count, 2);
    assert.equal(typeof (payloadUpdate.body?.payload as Record<string, unknown>).last_recalled_at, "string");

    const recallUpsert = calls.find((call) => call.method === "PUT" && call.url.endsWith("/points"));
    assert.ok(recallUpsert);
    assert.equal(recallUpsert.destination, "work");
    const payload = ((recallUpsert.body?.points as Array<{ payload: Record<string, unknown> }>)[0]?.payload);
    assert.equal(payload?.kind, "telemetry");
    assert.equal(payload?.memory_subtype, "recall_event");
    assert.deepEqual(payload?.returned_fact_ids, ["work-fact"]);
    assert.equal(payload?.result_count, 1);
    assert.equal(payload?.search_scope, "work");
  });

  it("writes recall telemetry and counters separately for each result destination", async () => {
    const calls = installStorageMock({
      searchResultsByDestination: {
        perso: [
          point("perso-fact", {
            recall_count: 0,
            updated_at: "2026-01-01T00:00:00.000Z",
          }),
        ],
        work: [
          point("work-fact", {
            recall_count: 3,
            updated_at: "2026-01-01T00:00:00.000Z",
          }),
        ],
      },
    });
    const handlers = collectTools();

    const result = await handlers.get("memory_recall")!({
      query: "where does bikky store memories?",
      search_scope: "all",
      output_format: "json",
    });

    const body = parseToolJson(result);
    assert.equal(body.result_count, 2);

    const payloadUpdates = calls.filter((call) => call.method === "POST" && call.url.endsWith("/points/payload"));
    assert.deepEqual(
      payloadUpdates.map((call) => [
        call.destination,
        call.body?.points,
        (call.body?.payload as Record<string, unknown>).recall_count,
      ]).sort(),
      [
        ["perso", ["perso-fact"], 1],
        ["work", ["work-fact"], 4],
      ],
    );

    const recallUpserts = calls.filter((call) => call.method === "PUT" && call.url.endsWith("/points"));
    assert.equal(recallUpserts.length, 2);
    assert.deepEqual(
      recallUpserts.map((call) => {
        const payload = ((call.body?.points as Array<{ payload: Record<string, unknown> }>)[0]?.payload);
        return [
          call.destination,
          payload?.returned_fact_ids,
          payload?.result_count,
          payload?.search_scope,
          payload?.searched_destinations,
        ];
      }).sort(),
      [
        ["perso", ["perso-fact"], 1, "all", ["perso", "work"]],
        ["work", ["work-fact"], 1, "all", ["perso", "work"]],
      ],
    );
  });

  it("writes useful feedback telemetry in the same destination as the source fact", async () => {
    const calls = installStorageMock({
      pointsByDestination: {
        work: {
          "work-fact": point("work-fact", { useful_count: 1 }),
        },
      },
    });
    const handlers = collectTools();

    const result = await handlers.get("memory_mark_useful")!({
      fact_id: "work-fact",
      note: "unblocked a routing debug session",
    });

    const body = parseToolJson(result);
    assert.equal(body.status, "marked_useful");
    assert.equal(body.destination, "work");
    assert.equal(body.useful_count, 2);

    const feedbackUpsert = calls.find((call) => call.method === "PUT" && call.url.endsWith("/points"));
    assert.ok(feedbackUpsert);
    assert.equal(feedbackUpsert.destination, "work");
    const payload = ((feedbackUpsert.body?.points as Array<{ payload: Record<string, unknown> }>)[0]!.payload);
    assert.equal(payload.kind, "telemetry");
    assert.equal(payload.memory_subtype, "feedback_event");
    assert.equal(payload.target_fact_id, "work-fact");
  });

  it("writes outcome telemetry in the same destination as the source fact", async () => {
    const calls = installStorageMock({
      pointsByDestination: {
        work: {
          "work-fact": point("work-fact"),
        },
      },
    });
    const handlers = collectTools();

    const result = await handlers.get("memory_report_outcome")!({
      fact_id: "work-fact",
      outcome: "misleading",
      notes: "old API path",
    });

    const body = parseToolJson(result);
    assert.equal(body.status, "outcome_recorded");
    assert.equal(body.destination, "work");
    assert.equal(body.outcome, "misleading");

    const outcomeUpsert = calls.find((call) => call.method === "PUT" && call.url.endsWith("/points"));
    assert.ok(outcomeUpsert);
    assert.equal(outcomeUpsert.destination, "work");
    const payload = ((outcomeUpsert.body?.points as Array<{ payload: Record<string, unknown> }>)[0]!.payload);
    assert.equal(payload.kind, "telemetry");
    assert.equal(payload.memory_subtype, "outcome_event");
    assert.equal(payload.target_fact_id, "work-fact");
    assert.equal(payload.outcome, "misleading");
  });
});
