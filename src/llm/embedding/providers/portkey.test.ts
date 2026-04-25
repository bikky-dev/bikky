import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { portkeyEmbeddingProvider } from "./portkey.js";
import type { ResolvedEmbeddingConfig } from "../types.js";

const baseCfg: ResolvedEmbeddingConfig = {
  provider: "portkey",
  model: "@openai/text-embedding-3-small",
  dimensions: 1536,
  baseUrl: "https://api.portkey.ai",
  apiKey: "pk-test",
  extra: {},
};

describe("portkey embedding provider", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("sends x-portkey-api-key + virtual key + config id when present", async () => {
    let captured: RequestInit | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ data: [{ embedding: [9, 9] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await portkeyEmbeddingProvider.embed("hi", {
      ...baseCfg,
      extra: { virtual_key: "vk-openai", config_id: "cfg-fallback" },
    });
    assert.deepStrictEqual(out, [9, 9]);
    const headers = captured!.headers as Record<string, string>;
    assert.strictEqual(headers["x-portkey-api-key"], "pk-test");
    assert.strictEqual(headers["x-portkey-virtual-key"], "vk-openai");
    assert.strictEqual(headers["x-portkey-config"], "cfg-fallback");
  });

  it("omits virtual key + config id when not in extra", async () => {
    let captured: RequestInit | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await portkeyEmbeddingProvider.embed("hi", baseCfg);
    const headers = captured!.headers as Record<string, string>;
    assert.ok(!("x-portkey-virtual-key" in headers));
    assert.ok(!("x-portkey-config" in headers));
  });

  it("throws when api key is missing", async () => {
    await assert.rejects(() => portkeyEmbeddingProvider.embed("hi", { ...baseCfg, apiKey: null }), {
      message: /api key not configured/,
    });
  });

  it("declares browserCompatible + portkey defaults", () => {
    assert.strictEqual(portkeyEmbeddingProvider.browserCompatible, true);
    assert.strictEqual(portkeyEmbeddingProvider.defaults.baseUrl, "https://api.portkey.ai");
  });
});
