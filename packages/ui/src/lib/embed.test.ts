/**
 * Tests for the bikky-ui embedding client.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { embed, isEmbeddingAvailable } from "./embed.js";
import { CONFIG_PATH, _resetConfig } from "./config.js";

const realFetch = globalThis.fetch;
const ENV_KEYS = ["EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_BASE_URL", "OPENAI_API_KEY"];
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

function writeConfig(cfg: object): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  _resetConfig();
}

describe("ui/lib/embed", () => {
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
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    _resetConfig();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("isEmbeddingAvailable returns false for bedrock", () => {
    writeConfig({ embedding: { provider: "bedrock" } });
    assert.equal(isEmbeddingAvailable(), false);
  });

  it("isEmbeddingAvailable returns true for ollama", () => {
    writeConfig({ embedding: { provider: "ollama" } });
    assert.equal(isEmbeddingAvailable(), true);
  });

  it("isEmbeddingAvailable returns true for openai", () => {
    writeConfig({ embedding: { provider: "openai", api_key: "k" } });
    assert.equal(isEmbeddingAvailable(), true);
  });

  it("embed throws when provider is bedrock", async () => {
    writeConfig({ embedding: { provider: "bedrock" } });
    await assert.rejects(embed("x"), /not available in the UI/);
  });

  it("embed POSTs to /v1/embeddings with the right body for ollama", async () => {
    writeConfig({
      embedding: { provider: "ollama", model: "qwen3-embed", base_url: "http://ollama.local:11434/" },
    });
    const calls = installMock(() => new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 }));

    const vec = await embed("hello world");

    assert.deepEqual(vec, [0.1, 0.2, 0.3]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "http://ollama.local:11434/v1/embeddings");
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.model, "qwen3-embed");
    assert.equal(body.input, "hello world");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["Authorization"], undefined);
  });

  it("embed adds Authorization: Bearer for openai", async () => {
    writeConfig({
      embedding: { provider: "openai", model: "text-embedding-3-small", api_key: "sk-test", base_url: "https://api.openai.com" },
    });
    const calls = installMock(() => new Response(JSON.stringify({
      data: [{ embedding: [0.5] }],
    }), { status: 200 }));

    await embed("x");

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer sk-test");
    assert.equal(calls[0]!.url, "https://api.openai.com/v1/embeddings");
  });

  it("embed throws a descriptive error on non-2xx responses", async () => {
    writeConfig({ embedding: { provider: "ollama", model: "qwen", base_url: "http://x" } });
    installMock(() => new Response("internal", { status: 500 }));

    await assert.rejects(embed("x"), /Embedding failed \[ollama\/qwen\] \(500\): internal/);
  });

  it("embed throws when the response has no data", async () => {
    writeConfig({ embedding: { provider: "ollama", model: "qwen", base_url: "http://x" } });
    installMock(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await assert.rejects(embed("x"), /Embedding response missing data/);
  });
});
