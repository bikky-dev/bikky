/**
 * Tests for the inference registry — dispatch + listing.
 * Provider-specific behaviour is tested in providers/*.test.ts.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  registerInferenceProvider,
  getInferenceProvider,
  listInferenceProviders,
  _resetInferenceRegistry,
} from "./registry.js";
import type { InferenceProvider } from "./types.js";

const fakeProvider: InferenceProvider = {
  name: "fake-inf",
  label: "Fake (test)",
  browserCompatible: false,
  defaults: { model: "fake-model" },
  async chat() { return "ok"; },
};

describe("inference registry", () => {
  let snapshot: InferenceProvider[];

  beforeEach(() => {
    snapshot = listInferenceProviders();
    _resetInferenceRegistry();
  });

  afterEach(() => {
    _resetInferenceRegistry();
    for (const p of snapshot) registerInferenceProvider(p);
  });

  it("registers and retrieves a provider by name", () => {
    registerInferenceProvider(fakeProvider);
    const got = getInferenceProvider("fake-inf");
    assert.strictEqual(got.name, "fake-inf");
    assert.strictEqual(got.defaults.model, "fake-model");
  });

  it("throws a helpful error when the provider is unknown", () => {
    registerInferenceProvider(fakeProvider);
    assert.throws(() => getInferenceProvider("nope"), {
      message: /Unknown inference provider: "nope"\. Registered: fake-inf/,
    });
  });

  it("lists all registered providers", () => {
    registerInferenceProvider(fakeProvider);
    registerInferenceProvider({ ...fakeProvider, name: "fake-2" });
    const names = listInferenceProviders().map((p) => p.name).sort();
    assert.deepStrictEqual(names, ["fake-2", "fake-inf"]);
  });
});

describe("built-in inference providers (registered via barrel import)", () => {
  it("registers ollama, openai, bedrock, portkey by importing the index", async () => {
    const snap = listInferenceProviders();
    _resetInferenceRegistry();
    try {
      await import("./providers/index.js");
      const names = listInferenceProviders().map((p) => p.name).sort();
      for (const expected of ["bedrock", "ollama", "openai", "portkey"]) {
        assert.ok(names.includes(expected), `expected ${expected} to be registered, got ${names.join(", ")}`);
      }
    } finally {
      _resetInferenceRegistry();
      for (const p of snap) registerInferenceProvider(p);
    }
  });
});
