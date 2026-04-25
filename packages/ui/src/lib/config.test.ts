/**
 * Tests for the bikky-ui config loader.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadConfig, _resetConfig, CONFIG_PATH } from "./config.js";

const ENV_KEYS = [
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "BIKKY_COLLECTION",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_BASE_URL",
  "OPENAI_API_KEY",
];

const savedEnv: Record<string, string | undefined> = {};
let savedConfig: string | null = null;
let configExisted = false;

describe("ui/lib/config", () => {
  before(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    if (fs.existsSync(CONFIG_PATH)) {
      configExisted = true;
      savedConfig = fs.readFileSync(CONFIG_PATH, "utf-8");
    }
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (savedConfig !== null) fs.writeFileSync(CONFIG_PATH, savedConfig);
    else if (!configExisted && fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    _resetConfig();
  });

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    _resetConfig();
  });

  it("returns defaults when no config file or env vars are set", () => {
    const cfg = loadConfig();
    assert.equal(cfg.qdrant_url, null);
    assert.equal(cfg.qdrant_api_key, null);
    assert.equal(cfg.collection, "bikky");
    assert.equal(cfg.embedding.provider, "ollama");
    assert.equal(cfg.embedding.base_url, "http://localhost:11434");
  });

  it("merges values from ~/.bikky/config.json", () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      qdrant_url: "https://qdrant.example:6333",
      qdrant_api_key: "abc123",
      collection: "custom",
      embedding: { provider: "openai", model: "text-embedding-3-small", api_key: "sk-xx" },
    }));

    const cfg = loadConfig();

    assert.equal(cfg.qdrant_url, "https://qdrant.example:6333");
    assert.equal(cfg.qdrant_api_key, "abc123");
    assert.equal(cfg.collection, "custom");
    assert.equal(cfg.embedding.provider, "openai");
    assert.equal(cfg.embedding.model, "text-embedding-3-small");
    assert.equal(cfg.embedding.api_key, "sk-xx");
    // Non-overridden defaults remain
    assert.equal(cfg.embedding.dimensions, 1024);
  });

  it("env vars take precedence over the config file", () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      qdrant_url: "https://from-file:6333",
      qdrant_api_key: "file-key",
    }));
    process.env.QDRANT_URL = "https://from-env:6333";
    process.env.QDRANT_API_KEY = "env-key";
    process.env.BIKKY_COLLECTION = "envcol";

    const cfg = loadConfig();

    assert.equal(cfg.qdrant_url, "https://from-env:6333");
    assert.equal(cfg.qdrant_api_key, "env-key");
    assert.equal(cfg.collection, "envcol");
  });

  it("strips trailing slashes from URLs", () => {
    process.env.QDRANT_URL = "https://qdrant.example:6333/////";
    process.env.EMBEDDING_BASE_URL = "http://ollama:11434/";

    const cfg = loadConfig();

    assert.equal(cfg.qdrant_url, "https://qdrant.example:6333");
    assert.equal(cfg.embedding.base_url, "http://ollama:11434");
  });

  it("falls back to defaults when the config file is corrupt", () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, "not json{{{");

    const cfg = loadConfig();

    assert.equal(cfg.qdrant_url, null);
    assert.equal(cfg.collection, "bikky");
  });

  it("memoises the loaded config", () => {
    const a = loadConfig();
    const b = loadConfig();
    assert.equal(a, b);
  });
});
