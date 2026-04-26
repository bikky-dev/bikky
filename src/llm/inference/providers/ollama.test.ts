import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ollamaInferenceProvider } from "./ollama.js";
import type { ResolvedInferenceConfig } from "../types.js";

const cfg: ResolvedInferenceConfig = {
  provider: "ollama",
  model: "qwen2.5:7b",
  baseUrl: "http://localhost:11434",
  apiKey: null,
  fallback: null,
  extra: {},
  timeoutMs: 5_000,
  retries: 0,
  retryBaseDelayMs: 10,
};

const log = () => {};

describe("ollama inference provider", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("POSTs to /v1/chat/completions and returns trimmed content", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: "  hi  " } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await ollamaInferenceProvider.chat({ messages: [{ role: "user", content: "ping" }] }, cfg, log);
    assert.strictEqual(out, "hi");
    const cap = captured as unknown as { url: string; init: RequestInit };
    assert.strictEqual(cap.url, "http://localhost:11434/v1/chat/completions");
    const body = JSON.parse(cap.init.body as string);
    assert.strictEqual(body.model, "qwen2.5:7b");
  });

  it("downgrades json_schema response_format to json_object", async () => {
    let captured: RequestInit | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await ollamaInferenceProvider.chat({
      messages: [{ role: "user", content: "x" }],
      response_format: { type: "json_schema", json_schema: { name: "t", schema: { type: "object" } } },
    }, cfg, log);

    const body = JSON.parse((captured as unknown as RequestInit).body as string);
    assert.deepStrictEqual(body.response_format, { type: "json_object" });
  });

  it("returns null on non-OK response (recoverable)", async () => {
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const out = await ollamaInferenceProvider.chat({ messages: [{ role: "user", content: "x" }] }, cfg, log);
    assert.strictEqual(out, null);
  });

  it("returns null on network error (recoverable)", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const out = await ollamaInferenceProvider.chat({ messages: [{ role: "user", content: "x" }] }, cfg, log);
    assert.strictEqual(out, null);
  });
});
