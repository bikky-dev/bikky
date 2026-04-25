import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bedrockInferenceProvider, _resetBedrockInferenceClient } from "./bedrock.js";

describe("bedrock inference provider — metadata", () => {
  it("declares the correct name + label", () => {
    assert.strictEqual(bedrockInferenceProvider.name, "bedrock");
    assert.strictEqual(bedrockInferenceProvider.label, "AWS Bedrock (Converse)");
  });

  it("is NOT browserCompatible", () => {
    assert.strictEqual(bedrockInferenceProvider.browserCompatible, false);
  });

  it("defaults to Claude Sonnet 4 with no baseUrl", () => {
    assert.strictEqual(bedrockInferenceProvider.defaults.model, "us.anthropic.claude-sonnet-4-20250514");
    assert.strictEqual(bedrockInferenceProvider.defaults.baseUrl, undefined);
  });

  it("loads the AWS SDK lazily inside chat() (not at module load)", () => {
    assert.strictEqual(typeof bedrockInferenceProvider.chat, "function");
    assert.strictEqual(typeof _resetBedrockInferenceClient, "function");
  });
});
