/**
 * Tests for the public embedding API.
 *
 * Provider request shapes are tested in providers/*.test.ts; this file covers
 * resolution (defaults, overrides, baseUrl normalisation) and error paths.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  initEmbedding,
  getEmbeddingConfig,
  getEmbeddingDimensions,
  embed,
  _resetEmbedding,
} from "./index.js";

describe("initEmbedding — resolution", () => {
  beforeEach(() => _resetEmbedding());

  it("applies ollama defaults when no overrides given", async () => {
    const cfg = await initEmbedding({ provider: "ollama" });
    assert.strictEqual(cfg.provider, "ollama");
    assert.strictEqual(cfg.model, "qwen3-embedding:0.6b");
    assert.strictEqual(cfg.dimensions, 1024);
    assert.strictEqual(cfg.baseUrl, "http://localhost:11434");
    assert.strictEqual(cfg.apiKey, null);
    assert.deepStrictEqual(cfg.extra, {});
  });

  it("applies openai defaults", async () => {
    const cfg = await initEmbedding({ provider: "openai", apiKey: "sk-test" });
    assert.strictEqual(cfg.model, "text-embedding-3-small");
    assert.strictEqual(cfg.dimensions, 1536);
    assert.strictEqual(cfg.baseUrl, "https://api.openai.com");
    assert.strictEqual(cfg.apiKey, "sk-test");
  });

  it("applies bedrock defaults (no baseUrl)", async () => {
    const cfg = await initEmbedding({ provider: "bedrock" });
    assert.strictEqual(cfg.model, "amazon.titan-embed-text-v2:0");
    assert.strictEqual(cfg.dimensions, 1024);
    assert.strictEqual(cfg.baseUrl, "");
  });

  it("applies portkey defaults", async () => {
    const cfg = await initEmbedding({ provider: "portkey", apiKey: "pk-test" });
    assert.strictEqual(cfg.model, "@openai/text-embedding-3-small");
    assert.strictEqual(cfg.baseUrl, "https://api.portkey.ai");
    assert.strictEqual(cfg.dimensions, 1536);
  });

  it("overrides win over defaults", async () => {
    const cfg = await initEmbedding({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
      baseUrl: "http://custom:11434",
    });
    assert.strictEqual(cfg.model, "nomic-embed-text");
    assert.strictEqual(cfg.dimensions, 768);
    assert.strictEqual(cfg.baseUrl, "http://custom:11434");
  });

  it("strips trailing slashes from baseUrl", async () => {
    const cfg = await initEmbedding({
      provider: "ollama",
      baseUrl: "http://localhost:11434///",
    });
    assert.strictEqual(cfg.baseUrl, "http://localhost:11434");
  });

  it("passes extra bag through unchanged", async () => {
    const cfg = await initEmbedding({
      provider: "portkey",
      apiKey: "pk",
      extra: { virtual_key: "vk-1", config_id: "cfg-2" },
    });
    assert.deepStrictEqual(cfg.extra, { virtual_key: "vk-1", config_id: "cfg-2" });
  });

  it("throws when provider is unknown", () => {
    assert.throws(() => initEmbedding({ provider: "nope" }), {
      message: /Unknown embedding provider: "nope"/,
    });
  });
});

describe("getEmbeddingConfig / getEmbeddingDimensions", () => {
  it("throws when not initialised", () => {
    _resetEmbedding();
    assert.throws(() => getEmbeddingConfig(), { message: /not initialized/ });
    assert.throws(() => getEmbeddingDimensions(), { message: /not initialized/ });
  });

  it("returns the resolved config / dimensions", async () => {
    await initEmbedding({ provider: "openai", apiKey: "k", dimensions: 512 });
    assert.strictEqual(getEmbeddingDimensions(), 512);
    assert.strictEqual(getEmbeddingConfig().provider, "openai");
  });
});

describe("embed — input validation", () => {
  beforeEach(async () => {
    _resetEmbedding();
    await initEmbedding({ provider: "ollama", baseUrl: "http://localhost:99999" });
  });

  it("throws on empty text", async () => {
    await assert.rejects(() => embed(""), { message: /empty text/ });
  });

  it("throws on whitespace-only text", async () => {
    await assert.rejects(() => embed("   "), { message: /empty text/ });
  });

  it("throws when called before init", async () => {
    _resetEmbedding();
    await assert.rejects(() => embed("hello"), { message: /not initialized/ });
  });
});
