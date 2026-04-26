import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { openaiInferenceProvider } from "./openai.js";
import type { ResolvedInferenceConfig } from "../types.js";

const cfg: ResolvedInferenceConfig = {
  provider: "openai",
  model: "gpt-4.1-mini",
  baseUrl: "https://api.openai.com",
  apiKey: "sk-test",
  fallback: null,
  extra: {},
  timeoutMs: 5_000,
  retries: 0,
  retryBaseDelayMs: 10,
};

const log = () => {};

describe("openai inference provider", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("sends bearer auth header and forwards json_schema response_format unchanged", async () => {
    let captured: RequestInit | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await openaiInferenceProvider.chat({
      messages: [{ role: "user", content: "x" }],
      response_format: { type: "json_schema", json_schema: { name: "t", schema: { type: "object" } } },
    }, cfg, log);

    const init = captured as unknown as RequestInit;
    const headers = init.headers as Record<string, string>;
    assert.strictEqual(headers["Authorization"], "Bearer sk-test");
    const body = JSON.parse(init.body as string);
    assert.strictEqual(body.response_format.type, "json_schema");
  });

  it("returns null when no API key is configured", async () => {
    const out = await openaiInferenceProvider.chat(
      { messages: [{ role: "user", content: "x" }] },
      { ...cfg, apiKey: null }, log);
    assert.strictEqual(out, null);
  });

  it("returns null on HTTP error (recoverable)", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const out = await openaiInferenceProvider.chat({ messages: [{ role: "user", content: "x" }] }, cfg, log);
    assert.strictEqual(out, null);
  });
});
