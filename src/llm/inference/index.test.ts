/**
 * Tests for the public inference API — initLLM resolution + chatCompletion
 * dispatch + fallback orchestration.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  initLLM,
  chatCompletion,
  getInferenceConfig,
  registerInferenceProvider,
  _resetInference,
  _recordInferenceUsage,
} from "./index.js";
import {
  listInferenceProviders,
  _resetInferenceRegistry,
} from "./registry.js";
import type { InferenceProvider } from "./types.js";

describe("initLLM — resolution", () => {
  beforeEach(() => _resetInference());

  it("applies ollama defaults", () => {
    const cfg = initLLM({ config: { provider: "ollama" } });
    assert.strictEqual(cfg.provider, "ollama");
    assert.strictEqual(cfg.model, "qwen2.5:7b");
    assert.strictEqual(cfg.baseUrl, "http://localhost:11434");
    assert.strictEqual(cfg.fallback, null);
    assert.deepStrictEqual(cfg.extra, {});
  });

  it("applies openai defaults", () => {
    const cfg = initLLM({ config: { provider: "openai", apiKey: "k" } });
    assert.strictEqual(cfg.model, "gpt-4.1-mini");
    assert.strictEqual(cfg.baseUrl, "https://api.openai.com");
    assert.strictEqual(cfg.apiKey, "k");
  });

  it("applies portkey defaults + extra", () => {
    const cfg = initLLM({
      config: {
        provider: "portkey",
        apiKey: "pk",
        extra: { virtual_key: "vk-1" },
      },
    });
    assert.strictEqual(cfg.model, "@openai/gpt-4o-mini");
    assert.strictEqual(cfg.baseUrl, "https://api.portkey.ai");
    assert.strictEqual(cfg.extra.virtual_key, "vk-1");
  });

  it("throws on unknown provider", () => {
    assert.throws(() => initLLM({ config: { provider: "nope" } }), {
      message: /Unknown inference provider/,
    });
  });

  it("strips trailing slashes from baseUrl", () => {
    const cfg = initLLM({ config: { provider: "ollama", baseUrl: "http://x///" } });
    assert.strictEqual(cfg.baseUrl, "http://x");
  });
});

describe("getInferenceConfig", () => {
  it("throws when not initialised", () => {
    _resetInference();
    assert.throws(() => getInferenceConfig(), { message: /not initialized/ });
  });

  it("returns the resolved config after init", () => {
    initLLM({ config: { provider: "ollama" } });
    assert.strictEqual(getInferenceConfig().provider, "ollama");
  });
});

describe("chatCompletion — dispatch + fallback", () => {
  let snapshot: InferenceProvider[];
  let calls: string[];
  let telemetryDir: string;
  let telemetryFile: string;

  beforeEach(() => {
    snapshot = listInferenceProviders();
    _resetInferenceRegistry();
    _resetInference();
    calls = [];
    telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-inference-telemetry-"));
    telemetryFile = path.join(telemetryDir, "llm.jsonl");
    process.env.BIKKY_LLM_LOG = telemetryFile;
  });

  afterEach(() => {
    _resetInferenceRegistry();
    _resetInference();
    for (const p of snapshot) registerInferenceProvider(p);
    delete process.env.BIKKY_LLM_LOG;
    fs.rmSync(telemetryDir, { recursive: true, force: true });
  });

  function fakeProvider(name: string, result: string | null, usage?: Parameters<typeof _recordInferenceUsage>[0]): InferenceProvider {
    return {
      name,
      label: name,
      browserCompatible: false,
      defaults: { model: `${name}-model` },
      async chat() {
        calls.push(name);
        if (usage) _recordInferenceUsage(usage);
        return result;
      },
    };
  }

  it("returns the primary's result when it succeeds", async () => {
    registerInferenceProvider(fakeProvider("primary", "primary-said-hi"));
    initLLM({ config: { provider: "primary" } });
    const out = await chatCompletion({ messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(out, "primary-said-hi");
    assert.deepStrictEqual(calls, ["primary"]);
  });

  it("writes telemetry with prompt context and actual usage when provided", async () => {
    registerInferenceProvider(fakeProvider("primary", "primary-said-hi", {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      request_id: "req-1",
    }));
    initLLM({ config: { provider: "primary" } });

    const out = await chatCompletion({
      promptName: "test-prompt@1",
      messages: [{ role: "user", content: "hi" }],
      telemetry: { subsystem: "unit-test", session_id: "session-1", workstream_key: "workstream-1", trigger: "test" },
    });

    assert.strictEqual(out, "primary-said-hi");
    const lines = fs.readFileSync(telemetryFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(record.prompt, "test-prompt@1");
    assert.equal(record.subsystem, "unit-test");
    assert.equal(record.session_id, "session-1");
    assert.equal(record.workstream_key, "workstream-1");
    assert.equal(record.tokens_in_actual, 11);
    assert.equal(record.tokens_out_actual, 7);
    assert.equal(record.tokens_total_actual, 18);
    assert.equal(record.request_id, "req-1");
  });

  it("falls back to the configured fallback when primary returns null", async () => {
    registerInferenceProvider(fakeProvider("primary", null));
    registerInferenceProvider(fakeProvider("backup", "backup-said-hi"));
    initLLM({ config: { provider: "primary", fallback: "backup" } });
    const out = await chatCompletion({ messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(out, "backup-said-hi");
    assert.deepStrictEqual(calls, ["primary", "backup"]);
  });

  it("returns null when no fallback and primary fails", async () => {
    registerInferenceProvider(fakeProvider("primary", null));
    initLLM({ config: { provider: "primary" } });
    const out = await chatCompletion({ messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(out, null);
    assert.deepStrictEqual(calls, ["primary"]);
  });

  it("throws if fallback name is not registered", async () => {
    registerInferenceProvider(fakeProvider("primary", null));
    initLLM({ config: { provider: "primary", fallback: "ghost" } });
    await assert.rejects(
      () => chatCompletion({ messages: [{ role: "user", content: "hi" }] }),
      { message: /Unknown inference provider: "ghost"/ },
    );
  });
});
