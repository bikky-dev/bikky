/**
 * Tests for the daemon Qdrant client — unit tests only.
 *
 * These test initialization and validation logic without making
 * actual HTTP calls to Qdrant.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resetConfig, saveConfig, CONFIG_DEFAULTS } from "../config.js";
import {
  init,
  isReady,
  setLogger,
  setEmbeddingConfig,
} from "./qdrant.js";
import type { StoreFact } from "./qdrant.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let savedConfig: string | null = null;
const configPath = path.join(os.homedir(), ".bikky", "config.json");

// Env vars that override config — must be cleared for null-credential tests
const QDRANT_ENV_KEYS = ["QDRANT_URL", "QDRANT_API_KEY"];
let savedQdrantEnv: Record<string, string | undefined> = {};

describe("daemon/qdrant", () => {
  before(() => {
    if (fs.existsSync(configPath)) {
      savedConfig = fs.readFileSync(configPath, "utf-8");
    }
    // Save env vars
    for (const key of QDRANT_ENV_KEYS) {
      savedQdrantEnv[key] = process.env[key];
    }
  });

  after(() => {
    // Restore env vars
    for (const key of QDRANT_ENV_KEYS) {
      if (savedQdrantEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedQdrantEnv[key];
      }
    }
    // Restore config
    if (savedConfig !== null) {
      fs.writeFileSync(configPath, savedConfig);
    }
    resetConfig();
  });

  beforeEach(() => {
    // Clear qdrant env vars so saveConfig controls the values
    for (const key of QDRANT_ENV_KEYS) {
      delete process.env[key];
    }
    resetConfig();
  });

  // Restore config after all tests in this file
  // Note: this runs once since we only save the original once

  // ── isReady ──────────────────────────────────────────────────────────────

  describe("isReady", () => {
    it("returns false before init when no credentials configured", () => {
      // Set config with null qdrant credentials
      saveConfig({
        ...CONFIG_DEFAULTS,
        qdrant_url: null,
        qdrant_api_key: null,
      });
      resetConfig();

      // isReady checks module-level state — after fresh module load it should be false
      // since we haven't called init()
      // Actually, isReady checks the module-level variables which may have been set by prior tests
      // But init() with null credentials will set qdrantUrl to null, so isReady returns false
      init();
      assert.strictEqual(isReady(), false);
    });
  });

  // ── init ─────────────────────────────────────────────────────────────────

  describe("init", () => {
    it("returns false when qdrant_url is null", () => {
      saveConfig({
        ...CONFIG_DEFAULTS,
        qdrant_url: null,
        qdrant_api_key: null,
      });
      resetConfig();

      const ready = init();
      assert.strictEqual(ready, false);
    });

    it("returns true when qdrant_url is set even if qdrant_api_key is null (self-hosted / Docker)", () => {
      saveConfig({
        ...CONFIG_DEFAULTS,
        qdrant_url: "https://my-qdrant.example.com:6333",
        qdrant_api_key: null,
      });
      resetConfig();

      const ready = init();
      assert.strictEqual(ready, true);
    });

    it("returns true when both url and api_key are set", () => {
      saveConfig({
        ...CONFIG_DEFAULTS,
        qdrant_url: "https://my-qdrant.example.com:6333",
        qdrant_api_key: "test-api-key",
      });
      resetConfig();

      const ready = init();
      assert.strictEqual(ready, true);
    });

    it("isReady returns true after successful init", () => {
      saveConfig({
        ...CONFIG_DEFAULTS,
        qdrant_url: "https://my-qdrant.example.com:6333",
        qdrant_api_key: "test-api-key",
      });
      resetConfig();

      init();
      assert.strictEqual(isReady(), true);
    });

    it("isReady returns false after init with missing credentials", () => {
      saveConfig({
        ...CONFIG_DEFAULTS,
        qdrant_url: null,
        qdrant_api_key: null,
      });
      resetConfig();

      init();
      assert.strictEqual(isReady(), false);
    });
  });

  // ── setLogger ────────────────────────────────────────────────────────────

  describe("setLogger", () => {
    it("does not throw when called with a function", () => {
      assert.doesNotThrow(() => {
        setLogger((level: string, ...args: unknown[]) => {
          // noop logger
        });
      });
    });

    it("does not throw when called with noop", () => {
      assert.doesNotThrow(() => {
        setLogger(() => {});
      });
    });
  });

  // ── setEmbeddingConfig ───────────────────────────────────────────────────

  describe("setEmbeddingConfig", () => {
    it("does not throw when called with overrides", () => {
      assert.doesNotThrow(() => {
        setEmbeddingConfig({ provider: "ollama", model: "nomic-embed-text" });
      });
    });

    it("does not throw when called with undefined", () => {
      assert.doesNotThrow(() => {
        setEmbeddingConfig(undefined);
      });
    });

    it("does not throw when called with empty overrides", () => {
      assert.doesNotThrow(() => {
        setEmbeddingConfig({});
      });
    });
  });

  // ── StoreFact type shape ─────────────────────────────────────────────────

  describe("StoreFact type", () => {
    it("accepts minimal required fields", () => {
      const fact: StoreFact = {
        content: "test content",
        category: "infrastructure",
        entities: ["test"],
        content_hash: "abc123",
      };
      assert.ok(fact.content);
      assert.ok(fact.category);
      assert.ok(Array.isArray(fact.entities));
      assert.ok(fact.content_hash);
    });

    it("accepts all optional fields", () => {
      const fact: StoreFact = {
        content: "test content",
        category: "decisions",
        entities: ["redis", "cache"],
        content_hash: "def456",
        domain: "work",
        kind: "fact",
        source: "agent",
        confidence: 0.9,
        importance: 0.7,
        metadata: { session_id: "abc" },
        relation: { from: "redis", type: "uses", to: "cache" },
      };
      assert.strictEqual(fact.domain, "work");
      assert.strictEqual(fact.kind, "fact");
      assert.strictEqual(fact.source, "agent");
      assert.strictEqual(fact.confidence, 0.9);
      assert.strictEqual(fact.importance, 0.7);
      assert.deepStrictEqual(fact.metadata, { session_id: "abc" });
      assert.deepStrictEqual(fact.relation, { from: "redis", type: "uses", to: "cache" });
    });

    it("accepts null relation", () => {
      const fact: StoreFact = {
        content: "test",
        category: "observation",
        entities: [],
        content_hash: "ghi789",
        relation: null,
      };
      assert.strictEqual(fact.relation, null);
    });
  });
});
