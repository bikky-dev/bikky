import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { openaiInferenceProvider } from "./openai.js";
import { chatCompletion, initLLM, _resetInference } from "../index.js";
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
  let telemetryDir: string;
  let telemetryFile: string;

  beforeEach(() => {
    globalThis.fetch = realFetch;
    telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-openai-telemetry-"));
    telemetryFile = path.join(telemetryDir, "llm.jsonl");
    process.env.BIKKY_LLM_LOG = telemetryFile;
    _resetInference();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.BIKKY_LLM_LOG;
    fs.rmSync(telemetryDir, { recursive: true, force: true });
    _resetInference();
  });

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

  it("exposes OpenAI usage metadata through chatCompletion telemetry", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }), { status: 200 })) as unknown as typeof fetch;

    initLLM({ config: { provider: "openai", apiKey: "sk-test", retries: 0 } });
    const out = await chatCompletion({
      promptName: "openai-test@1",
      messages: [{ role: "user", content: "x" }],
      telemetry: { subsystem: "unit-test" },
    });

    assert.equal(out, "ok");
    const record = JSON.parse(fs.readFileSync(telemetryFile, "utf-8").trim()) as Record<string, unknown>;
    assert.equal(record.tokens_in_actual, 12);
    assert.equal(record.tokens_out_actual, 4);
    assert.equal(record.tokens_total_actual, 16);
    assert.equal(record.request_id, "chatcmpl-1");
  });
});
