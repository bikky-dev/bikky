/**
 * Tests for the embedding registry — the dispatch layer.
 *
 * Provider-specific behaviour is tested in providers/*.test.ts.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  registerEmbeddingProvider,
  getEmbeddingProvider,
  listEmbeddingProviders,
  _resetEmbeddingRegistry,
} from "./registry.js";

const fakeProvider = {
  name: "fake-test",
  label: "Fake (test)",
  browserCompatible: true,
  defaults: { model: "fake-model", dimensions: 4 },
  async embed(): Promise<number[]> { return [0, 0, 0, 0]; },
};

describe("embedding registry", () => {
  let snapshot: ReturnType<typeof listEmbeddingProviders>;

  beforeEach(() => {
    snapshot = listEmbeddingProviders();
    _resetEmbeddingRegistry();
  });

  afterEach(() => {
    _resetEmbeddingRegistry();
    for (const p of snapshot) registerEmbeddingProvider(p);
  });

  it("registers and retrieves a provider by name", () => {
    registerEmbeddingProvider(fakeProvider);
    const got = getEmbeddingProvider("fake-test");
    assert.strictEqual(got.name, "fake-test");
    assert.strictEqual(got.defaults.dimensions, 4);
  });

  it("throws a helpful error when the provider is unknown", () => {
    registerEmbeddingProvider(fakeProvider);
    assert.throws(() => getEmbeddingProvider("nope"), {
      message: /Unknown embedding provider: "nope"\. Registered: fake-test/,
    });
  });

  it("lists all registered providers", () => {
    registerEmbeddingProvider(fakeProvider);
    registerEmbeddingProvider({ ...fakeProvider, name: "fake-2", label: "Fake 2" });
    const names = listEmbeddingProviders().map((p) => p.name).sort();
    assert.deepStrictEqual(names, ["fake-2", "fake-test"]);
  });
});

describe("built-in embedding providers (registered via barrel import)", () => {
  it("registers ollama, openai, bedrock, portkey by importing the index", async () => {
    // Snapshot before mutating
    const snap = listEmbeddingProviders();
    _resetEmbeddingRegistry();
    try {
      // Re-import the barrel — providers self-register.
      // (Cache-busting is unnecessary; the module-level register call ran on first import.)
      await import("./providers/index.js");
      const names = listEmbeddingProviders().map((p) => p.name).sort();
      // bedrock + ollama + openai + portkey
      for (const expected of ["bedrock", "ollama", "openai", "portkey"]) {
        assert.ok(names.includes(expected), `expected ${expected} to be registered, got ${names.join(", ")}`);
      }
    } finally {
      _resetEmbeddingRegistry();
      for (const p of snap) registerEmbeddingProvider(p);
    }
  });
});
