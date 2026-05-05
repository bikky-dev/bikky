import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-consolidation-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const { detectContradiction, setLogger, tick, _reset } = await import("./consolidation.js");
const qdrant = await import("./qdrant.js");
const { initLLM } = await import("../llm/index.js");
const { CONFIG_DEFAULTS, loadConfig, saveConfig } = await import("../config.js");

const realFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function configure(): void {
  saveConfig({
    ...CONFIG_DEFAULTS,
    destinations: [
      {
        name: "personal",
        qdrant_url: "https://personal.q.test",
        qdrant_api_key: null,
        collection: "personal_collection",
        default: true,
      },
    ],
    embedding: {
      ...CONFIG_DEFAULTS.embedding,
      provider: "ollama",
      base_url: "http://embed.test",
      model: "qwen-test",
      dimensions: 3,
      timeout_ms: 100,
      retries: 0,
    },
    llm: {
      ...CONFIG_DEFAULTS.llm,
      provider: "ollama",
      base_url: "http://llm.test",
      model: "llm-test",
      timeout_ms: 100,
      retries: 0,
    },
    qdrant_client: {
      ...CONFIG_DEFAULTS.qdrant_client,
      timeout_ms: 100,
      retries: 0,
    },
  });
  qdrant.init();
  initLLM({
    config: {
      provider: "ollama",
      baseUrl: "http://llm.test",
      model: "llm-test",
      timeoutMs: 100,
      retries: 0,
    },
    logger: () => {},
  });
}

function installMock(opts: {
  candidates?: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  llmContent?: string | null;
} = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url, method, body });

    if (url === "http://embed.test/v1/embeddings") {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
    }

    if (url === "http://llm.test/v1/chat/completions") {
      return new Response(JSON.stringify({
        choices: [{ message: { content: opts.llmContent ?? '{"outcome":"compatible"}' } }],
      }), { status: 200 });
    }

    if (url === "https://personal.q.test/collections/personal_collection/points/search") {
      return new Response(JSON.stringify({ result: opts.candidates ?? [] }), { status: 200 });
    }

    return new Response(JSON.stringify({ result: [] }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

describe("daemon/consolidation", () => {
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
    configure();
    _reset();
    setLogger(() => {});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("skips low-importance facts before embedding or search", async () => {
    const calls = installMock();

    const result = await detectContradiction({
      content: "A low-importance observation.",
      category: "engineering",
      entities: ["bikky"],
      importance: 0.1,
    }, loadConfig(), { destination: "personal" });

    assert.deepEqual(result, { contradiction: false });
    assert.deepEqual(calls, []);
  });

  it("uses the supplied destination collection and reports LLM-confirmed contradictions", async () => {
    const calls = installMock({
      candidates: [
        {
          id: "existing-1",
          score: 0.81,
          payload: {
            content: "Bikky stores personal memories in collection A.",
            category: "engineering",
          },
        },
      ],
      llmContent: '{"outcome":"contradicted","existing_id":"existing-1","reason":"collection changed"}',
    });

    const result = await detectContradiction({
      content: "Bikky stores personal memories in collection B.",
      category: "engineering",
      entities: ["bikky"],
      importance: 0.9,
    }, loadConfig(), {
      destination: "personal",
      sessionId: "session-1",
      workstreamKey: "workstream-1",
    });

    assert.deepEqual(result, {
      contradiction: true,
      existingId: "existing-1",
      existingContent: "Bikky stores personal memories in collection A.",
      reason: "collection changed",
    });

    const searchCall = calls.find((call) => call.url.includes("/points/search"));
    assert.ok(searchCall);
    assert.equal(searchCall.url, "https://personal.q.test/collections/personal_collection/points/search");
    assert.deepEqual(searchCall.body?.filter, {
      must: [{ is_null: { key: "superseded_by" } }],
    });
    assert.equal(calls.filter((call) => call.url === "http://llm.test/v1/chat/completions").length, 1);
  });

  it("does not call the LLM when vector search finds no contradiction candidates", async () => {
    const calls = installMock({
      candidates: [
        {
          id: "too-similar",
          score: 0.95,
          payload: { content: "Duplicate fact", category: "engineering" },
        },
        {
          id: "too-distant",
          score: 0.2,
          payload: { content: "Unrelated fact", category: "engineering" },
        },
      ],
    });

    const result = await detectContradiction({
      content: "Bikky stores personal memories in collection B.",
      category: "engineering",
      entities: ["bikky"],
      importance: 0.9,
    }, loadConfig(), { destination: "personal" });

    assert.deepEqual(result, { contradiction: false });
    assert.equal(calls.some((call) => call.url === "http://llm.test/v1/chat/completions"), false);
  });

  it("does not run maintenance work when consolidation is disabled", async () => {
    const calls = installMock();
    const posts: string[] = [];
    const config = {
      ...loadConfig(),
      daemon: {
        ...loadConfig().daemon,
        consolidation_enabled: false,
      },
    };

    _reset(4999);
    await tick(config, { postHealthFn: async (text) => { posts.push(text); } });

    assert.deepEqual(calls, []);
    assert.deepEqual(posts, []);
  });

  it("skips maintenance when Qdrant is not ready", async () => {
    const calls = installMock();
    const posts: string[] = [];
    const config = {
      ...loadConfig(),
      qdrant_url: null,
      qdrant_api_key: null,
      destinations: [],
    };
    saveConfig(config);
    qdrant.init();

    _reset(4999);
    await tick(loadConfig(), { postHealthFn: async (text) => { posts.push(text); } });

    assert.deepEqual(calls, []);
    assert.deepEqual(posts, []);
  });

  it("posts a health report on the configured maintenance cadence", async () => {
    const calls = installMock();
    const posts: string[] = [];

    _reset(4999);
    await tick(loadConfig(), { postHealthFn: async (text) => { posts.push(text); } });

    assert.equal(posts.length, 1);
    assert.match(posts[0]!, /Memory Health Report/);
    assert.match(posts[0]!, /Total facts: 0/);
    assert.ok(calls.some((call) => call.url.endsWith("/points/count")));
    assert.ok(calls.some((call) => call.url.endsWith("/points/scroll")));
  });
});
