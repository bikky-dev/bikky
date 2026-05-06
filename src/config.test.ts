/**
 * Tests for the config system.
 *
 * Uses BIKKY_HOME to point at an isolated tempdir for the entire test file —
 * this prevents saveConfig() from clobbering the user's real ~/.bikky/config.json
 * if a test crashes mid-run (root cause of issue #58).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Set BIKKY_HOME *before* importing config so all derived paths use it.
const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-home-config-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const {
  loadConfig,
  resetConfig,
  saveConfig,
  CONFIG_PATH,
  BIKKY_DIR,
  LOG_DIR,
  STATE_DIR,
  CONFIG_DEFAULTS,
  getActiveConfigEnvOverrides,
  inspectConfigFile,
  validateConfigObject,
} = await import("./config.js");

// ---------------------------------------------------------------------------
// Helpers: backup & restore any existing config (now scoped to BIKKY_HOME tempdir)
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
  "BIKKY_LLM_EXTRA_REGION",
  "BIKKY_EMBEDDING_EXTRA_REGION",
  "BIKKY_DAEMON_RELATION_INFERENCE_ENABLED",
  "BIKKY_DAEMON_RELATION_INFERENCE_INTERVAL_SEC",
  "BIKKY_DAEMON_RELATION_INFERENCE_MAX_PAIRS_PER_RUN",
  "BIKKY_DAEMON_ENTITY_TYPING_ENABLED",
  "BIKKY_DAEMON_ENTITY_TYPING_INTERVAL_SEC",
  "BIKKY_DAEMON_ENTITY_TYPING_MAX_ENTITIES_PER_RUN",
  "BIKKY_USER_ID",
  "BIKKY_USER_NAME",
  "BIKKY_AGENT_ID",
  "BIKKY_AGENT_NAME",
  "BIKKY_ACTOR_ID",
  "BIKKY_ACTOR_LABEL",
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
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
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
    it("BIKKY_DIR honours BIKKY_HOME env var", () => {
      assert.strictEqual(BIKKY_DIR, TEST_BIKKY_HOME);
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

    it("llm.fallback_provider defaults to null", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.fallback_provider ?? null, null);
    });

    it("daemon has expected defaults", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.daemon.tick_interval_sec, 5);
      assert.strictEqual(cfg.daemon.extract_every_sec, 300);
      assert.strictEqual(cfg.daemon.extract_min_events, 10);
      assert.strictEqual(cfg.daemon.consolidation_enabled, true);
      assert.strictEqual(cfg.daemon.relation_inference_enabled, true);
      assert.strictEqual(cfg.daemon.relation_inference_interval_sec, 7200);
      assert.strictEqual(cfg.daemon.relation_inference_max_pairs_per_run, 3);
      assert.strictEqual(cfg.daemon.entity_typing_enabled, true);
      assert.strictEqual(cfg.daemon.entity_typing_interval_sec, 900);
      assert.strictEqual(cfg.daemon.entity_typing_max_entities_per_run, 5);
      assert.strictEqual(cfg.daemon.staleness_threshold_days, 30);
    });

    it("watchers.copilot.enabled defaults to true", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.watchers.copilot.enabled, true);
    });

    it("watchers.claude.enabled defaults to true", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.watchers.claude.enabled, true);
    });

    it("identity defaults to no configured user or legacy actor", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.strictEqual(cfg.identity.user_id, null);
      assert.strictEqual(cfg.identity.user_name, null);
      assert.strictEqual(cfg.identity.actor_id, null);
      assert.strictEqual(cfg.identity.actor_label, null);
    });

    it("search scope defaults preserve routed single-destination behavior", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      const cfg = loadConfig();
      assert.deepStrictEqual(cfg.default_search_scope, "routed");
      assert.deepStrictEqual(cfg.search_scopes, []);
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

    it("ignores invalid EMBEDDING_DIMENSIONS values", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.EMBEDDING_DIMENSIONS = "not-a-number";
      const cfg = loadConfig();
      assert.strictEqual(cfg.embedding.dimensions, 1024);
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

    it("AWS_BEDROCK_REGION populates llm.extra.region", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.AWS_BEDROCK_REGION = "eu-west-1";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.extra?.region, "eu-west-1");
    });

    it("AWS_REGION falls back to llm.extra.region when AWS_BEDROCK_REGION not set", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.AWS_REGION = "ap-southeast-1";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.extra?.region, "ap-southeast-1");
    });

    it("AWS_BEDROCK_REGION takes priority over AWS_REGION", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.AWS_BEDROCK_REGION = "us-west-2";
      process.env.AWS_REGION = "eu-central-1";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.extra?.region, "us-west-2");
    });

    it("BIKKY_LLM_EXTRA_<KEY> env vars populate llm.extra", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.BIKKY_LLM_EXTRA_VIRTUAL_KEY = "vk-1";
      const cfg = loadConfig();
      assert.strictEqual(cfg.llm.extra?.virtual_key, "vk-1");
      delete process.env.BIKKY_LLM_EXTRA_VIRTUAL_KEY;
    });

    it("BIKKY_DAEMON_* env vars override maintenance controls", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.BIKKY_DAEMON_RELATION_INFERENCE_ENABLED = "false";
      process.env.BIKKY_DAEMON_RELATION_INFERENCE_INTERVAL_SEC = "3600";
      process.env.BIKKY_DAEMON_RELATION_INFERENCE_MAX_PAIRS_PER_RUN = "2";
      process.env.BIKKY_DAEMON_ENTITY_TYPING_ENABLED = "0";
      process.env.BIKKY_DAEMON_ENTITY_TYPING_INTERVAL_SEC = "1200";
      process.env.BIKKY_DAEMON_ENTITY_TYPING_MAX_ENTITIES_PER_RUN = "4";

      const cfg = loadConfig();

      assert.strictEqual(cfg.daemon.relation_inference_enabled, false);
      assert.strictEqual(cfg.daemon.relation_inference_interval_sec, 3600);
      assert.strictEqual(cfg.daemon.relation_inference_max_pairs_per_run, 2);
      assert.strictEqual(cfg.daemon.entity_typing_enabled, false);
      assert.strictEqual(cfg.daemon.entity_typing_interval_sec, 1200);
      assert.strictEqual(cfg.daemon.entity_typing_max_entities_per_run, 4);
    });

    it("BIKKY_USER_* env vars override user identity", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.BIKKY_USER_ID = "saber-local";
      process.env.BIKKY_USER_NAME = "Saber";

      const cfg = loadConfig();

      assert.strictEqual(cfg.identity.user_id, "saber-local");
      assert.strictEqual(cfg.identity.user_name, "Saber");
    });

    it("BIKKY_ACTOR_* env vars still override legacy actor identity", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      process.env.BIKKY_ACTOR_ID = "saber-local";
      process.env.BIKKY_ACTOR_LABEL = "Saber";

      const cfg = loadConfig();

      assert.strictEqual(cfg.identity.actor_id, "saber-local");
      assert.strictEqual(cfg.identity.actor_label, "Saber");
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

    it("nested identity config merges correctly", () => {
      fs.mkdirSync(BIKKY_DIR, { recursive: true });
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          identity: {
            user_id: "configured-user",
            user_name: "Configured User",
            actor_id: "configured-actor",
            actor_label: "Configured Actor",
          },
        }),
      );

      const cfg = loadConfig();

      assert.strictEqual(cfg.identity.user_id, "configured-user");
      assert.strictEqual(cfg.identity.user_name, "Configured User");
      assert.strictEqual(cfg.identity.actor_id, "configured-actor");
      assert.strictEqual(cfg.identity.actor_label, "Configured Actor");
    });

    it("loads default_search_scope, search_scopes, and destination descriptions", () => {
      fs.mkdirSync(BIKKY_DIR, { recursive: true });
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({
          default_search_scope: ["work", "personal"],
          destinations: [
            {
              name: "work",
              description: "Engineering memory.",
              qdrant_url: "https://work.example",
              collection: "bikky-work",
            },
            {
              name: "personal",
              description: "Personal memory.",
              qdrant_url: "https://personal.example",
              collection: "bikky-personal",
            },
          ],
          search_scopes: [
            {
              name: "broad",
              description: "Search both configured stores.",
              destinations: ["work", "personal"],
            },
          ],
        }),
      );

      const cfg = loadConfig();

      assert.deepStrictEqual(cfg.default_search_scope, ["work", "personal"]);
      assert.strictEqual(cfg.destinations[0]?.description, "Engineering memory.");
      assert.strictEqual(cfg.search_scopes[0]?.name, "broad");
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

  // ── Config diagnostics ────────────────────────────────────────────────────

  describe("config diagnostics", () => {
    it("reports missing config file without errors", () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);

      const diag = inspectConfigFile();

      assert.equal(diag.exists, false);
      assert.equal(diag.parse_error, null);
      assert.deepEqual(diag.issues, []);
    });

    it("reports malformed JSON without throwing", () => {
      fs.mkdirSync(BIKKY_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, "{ invalid json !!!");

      const diag = inspectConfigFile();

      assert.equal(diag.exists, true);
      assert.ok(diag.parse_error);
      assert.equal(diag.issues[0]?.severity, "error");
      assert.equal(diag.issues[0]?.path, "$");
    });

    it("validates config object types and URL fields", () => {
      const issues = validateConfigObject({
        qdrant_url: "ftp://qdrant.example",
        collection: "",
        embedding: { dimensions: -1, base_url: "not a url" },
        daemon: {
          consolidation_enabled: "yes",
          relation_inference_interval_sec: -1,
          entity_typing_enabled: "yes",
        },
      });

      assert.ok(issues.some((issue) => issue.path === "qdrant_url"));
      assert.ok(issues.some((issue) => issue.path === "collection"));
      assert.ok(issues.some((issue) => issue.path === "embedding.dimensions"));
      assert.ok(issues.some((issue) => issue.path === "embedding.base_url"));
      assert.ok(issues.some((issue) => issue.path === "daemon.consolidation_enabled"));
      assert.ok(issues.some((issue) => issue.path === "daemon.relation_inference_interval_sec"));
      assert.ok(issues.some((issue) => issue.path === "daemon.entity_typing_enabled"));
    });

    it("accepts named search scopes as default_search_scope targets", () => {
      const issues = validateConfigObject({
        destinations: [{
          name: "work",
          qdrant_url: "https://work.example",
          collection: "bikky-work",
        }],
        default_search_scope: "broad",
        search_scopes: [{
          name: "broad",
          description: "Search work memory.",
          destinations: ["work"],
        }],
      });

      assert.ok(!issues.some((issue) => issue.path === "default_search_scope"));
    });

    it("lists active exact and provider-extra env overrides", () => {
      process.env.QDRANT_URL = "https://qdrant.example:6333";
      process.env.BIKKY_LLM_EXTRA_REGION = "us-west-2";

      const active = getActiveConfigEnvOverrides();

      assert.ok(active.includes("QDRANT_URL"));
      assert.ok(active.includes("BIKKY_LLM_EXTRA_REGION"));
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
