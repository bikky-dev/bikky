import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-session-destination-it-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const { registerTools } = await import("./mcp/tools.js");
const { CONFIG_DEFAULTS, resetConfig, saveConfig } = await import("./config.js");
const {
  initEmbedding,
  rebuildPool,
  setReady,
  setSetupError,
} = await import("./mcp/api.js");
const {
  init: initDaemonQdrant,
  storeFact: daemonStoreFact,
} = await import("./daemon/qdrant.js");
const { clearSessionDestinationOverride } = await import("./session-destination-override.js");

const realFetch = globalThis.fetch;

type ToolHandler = (args?: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

interface FetchCall {
  destination: string | null;
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

const collectTools = (): Map<string, ToolHandler> => {
  const handlers = new Map<string, ToolHandler>();
  registerTools({
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer);
  return handlers;
};

const parseToolJson = (result: Awaited<ReturnType<ToolHandler>>): Record<string, unknown> =>
  JSON.parse(result.content[0]!.text) as Record<string, unknown>;

const configureDestinations = (): void => {
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
    qdrant_url: null,
    qdrant_api_key: null,
    destinations: [
      {
        name: "perso",
        qdrant_url: "https://perso.q.test",
        qdrant_api_key: null,
        collection: "perso_collection",
        match: { content: ["[Bb]ikky"], entity: ["[Bb]ikky"] },
      },
      {
        name: "work",
        qdrant_url: "https://work.q.test",
        qdrant_api_key: null,
        collection: "work_collection",
        default: true,
      },
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
  setSetupError(null);
  setReady(true);
  initDaemonQdrant();
};

const installStorageMock = (): FetchCall[] => {
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
      return new Response(JSON.stringify({ result: { points: [] } }), { status: 200 });
    }

    if (url.endsWith("/points/search")) {
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    }

    if (method === "PUT" && url.endsWith("/points")) {
      return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 });
    }

    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as typeof fetch;

  return calls;
};

describe("session destination override integration", () => {
  before(() => {
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
  });

  after(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
    globalThis.fetch = realFetch;
    configureDestinations();
    clearSessionDestinationOverride();
  });

  it("routes both MCP and daemon writes through the persisted session override", async () => {
    const calls = installStorageMock();
    const handlers = collectTools();

    const setResult = await handlers.get("memory_set_session_destination")!({ destination: "work" });
    assert.equal(parseToolJson(setResult).status, "session_destination_set");

    const mcpResult = await handlers.get("memory_store")!({
      content: "Bikky integration routing would match perso without the override.",
      category: "engineering",
      entities: ["bikky"],
      domain: "software_engineering",
      kind: "fact",
      confidence: 0.9,
    });
    assert.equal(parseToolJson(mcpResult).destination, "work");

    await daemonStoreFact({
      content: "Bikky daemon integration routing would match perso without the override.",
      category: "engineering",
      entities: ["bikky"],
      content_hash: "daemon-integration-hash",
    });

    const upserts = calls.filter((call) => call.method === "PUT" && call.url.endsWith("/points"));
    assert.equal(upserts.length, 2);
    assert.deepEqual(upserts.map((call) => call.destination), ["work", "work"]);
    assert.equal(calls.some((call) => call.destination === "perso" && call.method !== "GET"), false);
  });
});
