/**
 * Tests for the embedding module.
 *
 * These tests verify initialization and config, NOT actual embedding calls
 * (which require a live Ollama/OpenAI/Bedrock service).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  initEmbedding,
  getEmbeddingConfig,
  getEmbeddingDimensions,
  embed,
} from "./embedding.js";

// ---------------------------------------------------------------------------
// initEmbedding
// ---------------------------------------------------------------------------

describe("initEmbedding", () => {
  it("returns config with ollama defaults when called with no args", () => {
    const cfg = initEmbedding();
    assert.strictEqual(cfg.provider, "ollama");
    assert.strictEqual(cfg.model, "qwen3-embedding:0.6b");
    assert.strictEqual(cfg.dimensions, 1024);
    assert.strictEqual(cfg.baseUrl, "http://localhost:11434");
    assert.strictEqual(cfg.apiKey, null);
  });

  it("accepts ollama provider with overrides", () => {
    const cfg = initEmbedding({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
      baseUrl: "http://custom:11434",
    });
    assert.strictEqual(cfg.provider, "ollama");
    assert.strictEqual(cfg.model, "nomic-embed-text");
    assert.strictEqual(cfg.dimensions, 768);
    assert.strictEqual(cfg.baseUrl, "http://custom:11434");
  });

  it("accepts openai provider", () => {
    const cfg = initEmbedding({
      provider: "openai",
      apiKey: "sk-test-key",
    });
    assert.strictEqual(cfg.provider, "openai");
    assert.strictEqual(cfg.model, "text-embedding-3-small");
    assert.strictEqual(cfg.dimensions, 1536);
    assert.strictEqual(cfg.baseUrl, "https://api.openai.com");
    assert.strictEqual(cfg.apiKey, "sk-test-key");
  });

  it("accepts bedrock provider", () => {
    const cfg = initEmbedding({ provider: "bedrock" });
    assert.strictEqual(cfg.provider, "bedrock");
    assert.strictEqual(cfg.model, "amazon.titan-embed-text-v2:0");
    assert.strictEqual(cfg.dimensions, 1024);
  });

  it("strips trailing slashes from baseUrl", () => {
    const cfg = initEmbedding({
      provider: "ollama",
      baseUrl: "http://localhost:11434///",
    });
    assert.strictEqual(cfg.baseUrl, "http://localhost:11434");
  });

  it("defaults apiKey to null when not provided", () => {
    const cfg = initEmbedding({ provider: "ollama" });
    assert.strictEqual(cfg.apiKey, null);
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingConfig
// ---------------------------------------------------------------------------

describe("getEmbeddingConfig", () => {
  it("returns the initialized config", () => {
    const init = initEmbedding({ provider: "openai", apiKey: "key-123" });
    const retrieved = getEmbeddingConfig();
    assert.deepStrictEqual(retrieved, init);
  });

  it("returns same object after init", () => {
    initEmbedding({ provider: "ollama" });
    const cfg = getEmbeddingConfig();
    assert.strictEqual(cfg.provider, "ollama");
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingDimensions
// ---------------------------------------------------------------------------

describe("getEmbeddingDimensions", () => {
  it("returns dimensions from initialized config", () => {
    initEmbedding({ provider: "ollama", dimensions: 512 });
    assert.strictEqual(getEmbeddingDimensions(), 512);
  });

  it("returns openai default dimensions", () => {
    initEmbedding({ provider: "openai" });
    assert.strictEqual(getEmbeddingDimensions(), 1536);
  });
});

// ---------------------------------------------------------------------------
// embed — error cases only (no live service calls)
// ---------------------------------------------------------------------------

describe("embed", () => {
  beforeEach(() => {
    // Ensure we're initialized but pointing to a non-existent server
    initEmbedding({
      provider: "ollama",
      baseUrl: "http://localhost:99999", // nothing listening
    });
  });

  it("throws on empty text", async () => {
    await assert.rejects(() => embed(""), {
      message: /empty text/,
    });
  });

  it("throws on whitespace-only text", async () => {
    await assert.rejects(() => embed("   "), {
      message: /empty text/,
    });
  });

  it("throws/rejects when service is unreachable", async () => {
    // This will fail to connect — we just verify it throws, not the exact message
    await assert.rejects(() => embed("test content"));
  });
});
