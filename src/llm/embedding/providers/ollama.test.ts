import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ollamaEmbeddingProvider } from "./ollama.js";
import type { ResolvedEmbeddingConfig } from "../types.js";

const cfg: ResolvedEmbeddingConfig = {
  provider: "ollama",
  model: "qwen3-embedding:0.6b",
  dimensions: 4,
  baseUrl: "http://localhost:11434",
  apiKey: null,
  extra: {},
  timeoutMs: 5_000,
  retries: 0,
  retryBaseDelayMs: 10,
};

describe("ollama embedding provider", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("POSTs to /v1/embeddings with model + input, no auth header", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init } as { url: string; init: RequestInit };
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3, 4] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await ollamaEmbeddingProvider.embed("hello", cfg);
    assert.deepStrictEqual(out, [1, 2, 3, 4]);
    assert.ok(captured, "fetch should have been called");
    const cap = captured as unknown as { url: string; init: RequestInit };
    assert.strictEqual(cap.url, "http://localhost:11434/v1/embeddings");
    assert.strictEqual(cap.init.method, "POST");
    const headers = cap.init.headers as Record<string, string>;
    assert.strictEqual(headers["Content-Type"], "application/json");
    assert.ok(!("Authorization" in headers), "should not send Authorization header");
    assert.deepStrictEqual(JSON.parse(cap.init.body as string), {
      model: "qwen3-embedding:0.6b", input: "hello",
    });
  });

  it("throws with status + body snippet on non-OK response", async () => {
    globalThis.fetch = (async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(() => ollamaEmbeddingProvider.embed("hi", cfg), {
      message: /\[ollama\/qwen3-embedding:0\.6b\] \(404\): model not found/,
    });
  });

  it("throws when response data array is empty", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(() => ollamaEmbeddingProvider.embed("hi", cfg), { message: /missing data/ });
  });

  it("declares browserCompatible + ollama defaults", () => {
    assert.strictEqual(ollamaEmbeddingProvider.name, "ollama");
    assert.strictEqual(ollamaEmbeddingProvider.browserCompatible, true);
    assert.strictEqual(ollamaEmbeddingProvider.defaults.dimensions, 1024);
  });
});
