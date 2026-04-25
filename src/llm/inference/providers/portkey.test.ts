import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { portkeyInferenceProvider } from "./portkey.js";
import type { ResolvedInferenceConfig } from "../types.js";

const cfg: ResolvedInferenceConfig = {
  provider: "portkey",
  model: "@openai/gpt-4o-mini",
  baseUrl: "https://api.portkey.ai",
  apiKey: "pk-test",
  fallback: null,
  extra: { virtual_key: "vk-1", config_id: "cfg-2" },
};

const log = () => {};

describe("portkey inference provider", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("sends portkey headers (api-key, virtual-key, config) when provided", async () => {
    let captured: RequestInit | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await portkeyInferenceProvider.chat({ messages: [{ role: "user", content: "x" }] }, cfg, log);

    const headers = (captured as unknown as RequestInit).headers as Record<string, string>;
    assert.strictEqual(headers["x-portkey-api-key"], "pk-test");
    assert.strictEqual(headers["x-portkey-virtual-key"], "vk-1");
    assert.strictEqual(headers["x-portkey-config"], "cfg-2");
  });

  it("omits optional headers when extras are absent", async () => {
    let captured: RequestInit | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await portkeyInferenceProvider.chat(
      { messages: [{ role: "user", content: "x" }] },
      { ...cfg, extra: {} }, log,
    );

    const headers = (captured as unknown as RequestInit).headers as Record<string, string>;
    assert.ok(!("x-portkey-virtual-key" in headers));
    assert.ok(!("x-portkey-config" in headers));
  });

  it("returns null when no API key is configured", async () => {
    const out = await portkeyInferenceProvider.chat(
      { messages: [{ role: "user", content: "x" }] },
      { ...cfg, apiKey: null }, log);
    assert.strictEqual(out, null);
  });
});
