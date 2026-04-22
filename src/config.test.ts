/**
 * Tests for the config system.
 *
 * Strategy: we backup/restore ~/.bikky/config.json around file-based tests
 * and use env var overrides + resetConfig() for env-var tests.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  loadConfig,
  resetConfig,
  saveConfig,
  CONFIG_PATH,
  BIKKY_DIR,
  LOG_DIR,
  STATE_DIR,
  CONFIG_DEFAULTS,
} from "./config.js";

// ---------------------------------------------------------------------------
// Helpers: backup & restore any existing config
// ---------------------------------------------------------------------------

let originalConfig: string | null = null;

function backupConfig(): void {
  if (fs.existsSync(CONFIG_PATH)) {
    originalConfig = fs.readFileSync(CONFIG_PATH, "utf-8");
  } else {
    originalConfig = null;
  }
}

function restoreConfig(): void {
  if (originalConfig !== null) {
    fs.writeFileSync(CONFIG_PATH, originalConfig);
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
}

// Env vars we might override — save/restore them
const ENV_KEYS = [
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "BIKKY_COLLECTION",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_DIMENSIONS",
  "OPENAI_API_KEY",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_BASE_URL",
  "AWS_BEDROCK_REGION",
  "AWS_REGION",
];

let savedEnv: Record<string, string | undefined> = {};

function saveEnv(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

function clearEnvOverrides(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config", () => {
  before(() => {
    backupConfig();
    saveEnv();
  });

  after(() => {
    restoreConfig();
    restoreEnv();
  });

  beforeEach(() => {
    resetConfig();
    clearEnvOverrides();
  });

  afterEach(() => {
    resetConfig();
    clearEnvOverrides();
  });

  // ── Path exports ──────────────────────────────────────────────────────────

  describe("path exports", () => {
    it("BIKKY_DIR is under home directory", () => {
      assert.ok(BIKKY_DIR.includes(".bikky"));
    });

    it("CONFIG_PATH is config.json inside BIKKY_DIR", () => {
      assert.strictEqual(CONFIG_PATH, path.join(BIKKY_DIR, "config.json"));
    });

    it("LOG_DIR is logs inside BIKKY_DIR", () => {
      assert.strictEqual(LOG_DIR, path.join(BIKKY_DIR, "logs"));
    });

    it("STATE_DIR is state inside BIKKY_DIR", () => {
      assert.strictEqual(STATE_DIR, path.join(BIKKY_DIR, "state"));
    });
  });

  // ── Defaults ──────────────────────────────────────────────────────────────

  describe("loadConfig() defaults", () => {
    it("returns valid config object when no config file and no env vars", () => {
      // Remove config file if present
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);

      const cfg = loadConfig();
      assert.ok(cfg);
      assert.strictEqual(typeof cfg, "object");
    });

    it("qdrant_url defaults to null", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.qdrant_url, null);
    });

    it("qdrant_api_key defaults to null", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.qdrant_api_key, null);
    });

    it("collection defaults to 'bikky'", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.collection, "bikky");
    });

    it("embedding.provider defaults to 'ollama'", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.provider, "ollama");
    });

    it("embedding.model defaults to 'qwen3-embedding:0.6b'", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.model, "qwen3-embedding:0.6b");
    });

    it("embedding.dimensions defaults to 1024", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.dimensions, 1024);
    });

    it("llm.provider defaults to 'ollama'", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.provider, "ollama");
    });

    it("llm.bedrock_region defaults to 'us-east-1'", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.bedrock_region, "us-east-1");
    });

    it("daemon has expected defaults", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.daemon.tick_interval_sec, 5);
      assert.strictEqual(cfg.daemon.extract_every_sec, 300);
      assert.strictEqual(cfg.daemon.extract_min_events, 5);
      assert.strictEqual(cfg.daemon.consolidation_enabled, true);
      assert.strictEqual(cfg.daemon.relation_inference_enabled, true);
      assert.strictEqual(cfg.daemon.staleness_threshold_days, 30);
    });

    it("watchers.copilot.enabled defaults to true", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.watchers.copilot.enabled, true);
    });

    it("watchers.claude.enabled defaults to false", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.watchers.claude.enabled, false);
    });
  });

  // ── CONFIG_DEFAULTS export ────────────────────────────────────────────────

  describe("CONFIG_DEFAULTS", () => {
    it("is exported and matches loadConfig defaults", () => {
      assert.ok(CONFIG_DEFAULTS);
      assert.strictEqual(CONFIG_DEFAULTS.collection, "bikky");
      assert.strictEqual(CONFIG_DEFAULTS.qdrant_url, null);
      assert.strictEqual(CONFIG_DEFAULTS.embedding.provider, "ollama");
    });
  });

  // ── resetConfig ───────────────────────────────────────────────────────────

  describe("resetConfig()", () => {
    it("clears the cache so loadConfig re-reads", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);

      // First load — defaults
      const first = loadConfig();
      assert.strictEqual(first.collection, "bikky");

      // Set an env var, reset, reload
      process.env.BIKKY_COLLECTION = "custom-collection";
      resetConfig();

      const second = loadConfig();
      assert.strictEqual(second.collection, "custom-collection");
    });
  });

  // ── Env var overrides ─────────────────────────────────────────────────────

  describe("env var overrides", () => {
    it("QDRANT_URL overrides default null", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.QDRANT_URL = "https://my-qdrant.example.com:6333";
      const cfg = loadConfig();
      assert.strictEqual(cfg.qdrant_url, "https://my-qdrant.example.com:6333");
    });

    it("QDRANT_API_KEY overrides default null", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.QDRANT_API_KEY = "test-api-key-123";
      const cfg = loadConfig();
      assert.strictEqual(cfg.qdrant_api_key, "test-api-key-123");
    });

    it("BIKKY_COLLECTION overrides collection", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.BIKKY_COLLECTION = "my-collection";
      const cfg = loadConfig();
      assert.strictEqual(cfg.collection, "my-collection");
    });

    it("EMBEDDING_PROVIDER overrides embedding.provider", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.EMBEDDING_PROVIDER = "openai";
      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.provider, "openai");
    });

    it("EMBEDDING_MODEL overrides embedding.model", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.EMBEDDING_MODEL = "text-embedding-3-large";
      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.model, "text-embedding-3-large");
    });

    it("EMBEDDING_BASE_URL overrides embedding.base_url", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.EMBEDDING_BASE_URL = "https://custom-ollama.local:8080";
      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.base_url, "https://custom-ollama.local:8080");
    });

    it("EMBEDDING_DIMENSIONS overrides embedding.dimensions", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.EMBEDDING_DIMENSIONS = "1536";
      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.dimensions, 1536);
    });

    it("OPENAI_API_KEY overrides embedding.api_key", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.OPENAI_API_KEY = "sk-test-key";
      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.api_key, "sk-test-key");
    });

    it("LLM_PROVIDER overrides llm.provider", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.LLM_PROVIDER = "bedrock";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.provider, "bedrock");
    });

    it("LLM_MODEL overrides llm.model", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.LLM_MODEL = "claude-3-haiku";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.model, "claude-3-haiku");
    });

    it("LLM_BASE_URL overrides llm.base_url", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.LLM_BASE_URL = "https://api.openai.com";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.base_url, "https://api.openai.com");
    });

    it("AWS_BEDROCK_REGION overrides llm.bedrock_region", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.AWS_BEDROCK_REGION = "eu-west-1";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.bedrock_region, "eu-west-1");
    });

    it("AWS_REGION falls back for bedrock_region when AWS_BEDROCK_REGION not set", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.AWS_REGION = "ap-southeast-1";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.bedrock_region, "ap-southeast-1");
    });

    it("AWS_BEDROCK_REGION takes priority over AWS_REGION", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.AWS_BEDROCK_REGION = "us-west-2";
      process.env.AWS_REGION = "eu-central-1";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.bedrock_region, "us-west-2");
    });
  });

  // ── URL trailing slash stripping ──────────────────────────────────────────

  describe("URL trailing slash stripping", () => {
    it("strips trailing slashes from QDRANT_URL", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.QDRANT_URL = "https://qdrant.example.com///";
      const cfg = loadConfig();
      assert.strictEqual(cfg.qdrant_url, "https://qdrant.example.com");
    });

    it("strips trailing slashes from EMBEDDING_BASE_URL", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.EMBEDDING_BASE_URL = "http://localhost:11434/";
      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.base_url, "http://localhost:11434");
    });

    it("strips trailing slashes from LLM_BASE_URL", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.LLM_BASE_URL = "http://localhost:11434/";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.base_url, "http://localhost:11434");
    });

    it("default base_urls have no trailing slashes", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.ok(!cfg.embedding.base_url.endsWith("/"));
      assert.ok(!cfg.llm.base_url.endsWith("/"));
    });
  });

  // ── File config deep merge ────────────────────────────────────────────────

  describe("file config deep merge", () => {
    it("file config overrides specific defaults while preserving others", () => {
      // Write a partial config file
      fs.mkdirSync(BIKKY_DIR, { recursive: true });
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          collection: "custom-collection",
          embedding: { model: "nomic-embed-text" },
        }),
      );

      const cfg = loadConfig();
      // Overridden
      assert.strictEqual(cfg.collection, "custom-collection");
      assert.strictEqual(cfg.embedding.model, "nomic-embed-text");
      // Preserved from defaults
      assert.strictEqual(cfg.embedding.provider, "ollama");
      assert.strictEqual(cfg.embedding.dimensions, 1024);
      assert.strictEqual(cfg.qdrant_url, null);
      assert.strictEqual(cfg.llm.provider, "ollama");
    });

    it("nested objects merge correctly (embedding overrides)", () => {
      fs.mkdirSync(BIKKY_DIR, { recursive: true });
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          embedding: {
            provider: "openai",
            model: "text-embedding-3-small",
            dimensions: 1536,
          },
        }),
      );

      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.provider, "openai");
      assert.strictEqual(cfg.embedding.model, "text-embedding-3-small");
      assert.strictEqual(cfg.embedding.dimensions, 1536);
      // base_url should still be default
      assert.strictEqual(cfg.embedding.base_url, "http://localhost:11434");
    });

    it("env vars override file config", () => {
      fs.mkdirSync(BIKKY_DIR, { recursive: true });
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ collection: "from-file" }),
      );
      process.env.BIKKY_COLLECTION = "from-env";

      const cfg = loadConfig();
      assert.strictEqual(cfg.collection, "from-env");
    });

    it("handles malformed config file gracefully", () => {
      fs.mkdirSync(BIKKY_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, "{ invalid json !!!");

      // Should not throw — falls back to defaults
      const cfg = loadConfig();
      assert.strictEqual(cfg.collection, "bikky");
    });
  });

  // ── saveConfig ────────────────────────────────────────────────────────────

  describe("saveConfig()", () => {
    it("writes config to disk", () => {
      const testConfig = {
        ...CONFIG_DEFAULTS,
        collection: "saved-collection",
      };
      saveConfig(testConfig);

      // Verify file exists and has correct content
      assert.ok(fs.existsSync(CONFIG_PATH));
      const written = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      assert.strictEqual(written.collection, "saved-collection");
    });

    it("updates the cache so loadConfig returns saved config", () => {
      const testConfig = {
        ...CONFIG_DEFAULTS,
        collection: "cached-collection",
      };
      saveConfig(testConfig);

      // loadConfig should return the saved config without re-reading
      const cfg = loadConfig();
      assert.strictEqual(cfg.collection, "cached-collection");
    });
  });

  // ── Caching behavior ─────────────────────────────────────────────────────

  describe("caching", () => {
    it("loadConfig returns same object on repeated calls (cached)", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const first = loadConfig();
      const second = loadConfig();
      assert.strictEqual(first, second); // same reference
    });

    it("resetConfig + loadConfig returns new object", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const first = loadConfig();
      resetConfig();
      const second = loadConfig();
      assert.notStrictEqual(first, second); // different reference
    });
  });

  // ── Directory creation ────────────────────────────────────────────────────

  describe("directory creation", () => {
    it("loadConfig creates BIKKY_DIR, LOG_DIR, STATE_DIR", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.ok(cfg); // loaded successfully
      assert.ok(fs.existsSync(BIKKY_DIR));
      assert.ok(fs.existsSync(LOG_DIR));
      assert.ok(fs.existsSync(STATE_DIR));
    });
  });
});
