import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { openaiEmbeddingProvider } from "./openai.js";
import type { ResolvedEmbeddingConfig } from "../types.js";

const baseCfg: ResolvedEmbeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
  baseUrl: "https://api.openai.com",
  apiKey: "sk-test",
  extra: {},
  timeoutMs: 5_000,
  retries: 0,
  retryBaseDelayMs: 10,
};

describe("openai embedding provider", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("POSTs to /v1/embeddings with bearer auth", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await openaiEmbeddingProvider.embed("hello", baseCfg);
    assert.deepStrictEqual(out, [0.1, 0.2]);
    assert.strictEqual(captured!.url, "https://api.openai.com/v1/embeddings");
    const headers = captured!.init.headers as Record<string, string>;
    assert.strictEqual(headers["Authorization"], "Bearer sk-test");
  });

  it("throws when api key is missing", async () => {
    await assert.rejects(() => openaiEmbeddingProvider.embed("hi", { ...baseCfg, apiKey: null }), {
      message: /api key not configured/,
    });
  });

  it("surfaces upstream error status + body", async () => {
    globalThis.fetch = (async () => new Response("invalid_api_key", { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(() => openaiEmbeddingProvider.embed("hi", baseCfg), {
      message: /\[openai\/text-embedding-3-small\] \(401\): invalid_api_key/,
    });
  });

  it("forwards dimensions in body for text-embedding-3 models", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await openaiEmbeddingProvider.embed("hi", { ...baseCfg, dimensions: 1024 });
    const body = JSON.parse(captured!.init.body as string) as { dimensions?: number };
    assert.strictEqual(body.dimensions, 1024);
  });

  it("omits dimensions for legacy ada-002 model", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await openaiEmbeddingProvider.embed("hi", {
      ...baseCfg,
      model: "text-embedding-ada-002",
      dimensions: 1536,
    });
    const body = JSON.parse(captured!.init.body as string) as { dimensions?: number };
    assert.strictEqual(body.dimensions, undefined);
  });

  it("declares browserCompatible + openai defaults", () => {
    assert.strictEqual(openaiEmbeddingProvider.browserCompatible, true);
    assert.strictEqual(openaiEmbeddingProvider.defaults.model, "text-embedding-3-small");
    assert.strictEqual(openaiEmbeddingProvider.defaults.dimensions, 1024);
  });
});
