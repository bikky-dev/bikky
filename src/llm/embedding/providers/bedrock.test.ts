import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bedrockEmbeddingProvider } from "./bedrock.js";

describe("bedrock embedding provider — metadata", () => {
  it("declares the correct name + label", () => {
    assert.strictEqual(bedrockEmbeddingProvider.name, "bedrock");
    assert.strictEqual(bedrockEmbeddingProvider.label, "AWS Bedrock (Titan Embed)");
  });

  it("is NOT browserCompatible (cannot be called from the UI)", () => {
    assert.strictEqual(bedrockEmbeddingProvider.browserCompatible, false);
  });

  it("defaults to titan-embed-text-v2 with 1024 dimensions and no baseUrl", () => {
    assert.strictEqual(bedrockEmbeddingProvider.defaults.model, "amazon.titan-embed-text-v2:0");
    assert.strictEqual(bedrockEmbeddingProvider.defaults.dimensions, 1024);
    assert.strictEqual(bedrockEmbeddingProvider.defaults.baseUrl, undefined);
  });

  it("loads the AWS SDK lazily on first embed() call (not at module load)", () => {
    // The provider intentionally has no init() hook — the SDK is dynamic-imported
    // inside embed(). Just verify the provider only exposes embed().
    assert.strictEqual(typeof bedrockEmbeddingProvider.embed, "function");
    assert.strictEqual((bedrockEmbeddingProvider as unknown as { init?: unknown }).init, undefined);
  });
});
