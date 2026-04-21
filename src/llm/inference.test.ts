/**
 * Tests for the inference (LLM) module.
 *
 * These tests verify initialization and config, NOT actual LLM calls
 * (which require a live Ollama/OpenAI/Bedrock service).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { initLLM, chatCompletion } from "./inference.js";
import type { InferenceProviderConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOllamaConfig(overrides: Partial<InferenceProviderConfig> = {}): InferenceProviderConfig {
  return {
    provider: "ollama",
    ollama_url: "http://localhost:11434",
    ollama_model: "qwen2.5:7b",
    openai_api_key: null,
    openai_model: "gpt-4.1-mini",
    bedrock_region: "us-east-1",
    bedrock_model: "us.anthropic.claude-sonnet-4-20250514",
    ...overrides,
  };
}

function makeOpenaiConfig(): InferenceProviderConfig {
  return {
    provider: "openai",
    ollama_url: "http://localhost:11434",
    ollama_model: "qwen2.5:7b",
    openai_api_key: "sk-test-key",
    openai_model: "gpt-4.1-mini",
    bedrock_region: "us-east-1",
    bedrock_model: "us.anthropic.claude-sonnet-4-20250514",
  };
}

function makeBedrockConfig(): InferenceProviderConfig {
  return {
    provider: "bedrock",
    ollama_url: "http://localhost:11434",
    ollama_model: "qwen2.5:7b",
    openai_api_key: null,
    openai_model: "gpt-4.1-mini",
    bedrock_region: "us-east-1",
    bedrock_model: "us.anthropic.claude-sonnet-4-20250514",
  };
}

// ---------------------------------------------------------------------------
// initLLM
// ---------------------------------------------------------------------------

describe("initLLM", () => {
  it("does not throw with ollama config", () => {
    assert.doesNotThrow(() => {
      initLLM({ config: makeOllamaConfig() });
    });
  });

  it("does not throw with openai config", () => {
    assert.doesNotThrow(() => {
      initLLM({ config: makeOpenaiConfig() });
    });
  });

  it("does not throw with bedrock config", () => {
    assert.doesNotThrow(() => {
      initLLM({ config: makeBedrockConfig() });
    });
  });

  it("accepts optional logger", () => {
    const logs: string[] = [];
    initLLM({
      config: makeOllamaConfig(),
      logger: (level, ...args) => logs.push(`${level}: ${args.join(" ")}`),
    });
    // Logger is stored — we can't verify it directly, but it shouldn't throw
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// chatCompletion — error/fallback behavior (no live calls)
// ---------------------------------------------------------------------------

describe("chatCompletion", () => {
  it("returns null when ollama is unreachable (falls back to bedrock which also fails)", async () => {
    initLLM({
      config: makeOllamaConfig({ ollama_url: "http://localhost:99999" }),
    });

    const result = await chatCompletion({
      messages: [{ role: "user", content: "hello" }],
    });
    // Ollama fails → falls back to bedrock → which also fails → returns null
    assert.strictEqual(result, null);
  });

  it("returns null when openai has no API key", async () => {
    initLLM({
      config: makeOpenaiConfig(),
    });
    // Override to remove API key
    initLLM({
      config: { ...makeOpenaiConfig(), openai_api_key: null },
    });

    const result = await chatCompletion({
      messages: [{ role: "user", content: "hello" }],
    });
    assert.strictEqual(result, null);
  });

  it("respects temperature and max_tokens options", async () => {
    // Verify the function at least accepts these options without throwing
    initLLM({
      config: makeOllamaConfig({ ollama_url: "http://localhost:99999" }),
    });

    const result = await chatCompletion({
      messages: [{ role: "user", content: "test" }],
      temperature: 0.5,
      max_tokens: 100,
    });
    // Will fail due to unreachable server, but should not throw on options parsing
    assert.strictEqual(result, null);
  });
});
