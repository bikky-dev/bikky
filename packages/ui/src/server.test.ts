/**
 * Tests for the createApp() Hono server — health, error mapping, SPA fallback.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createApp } from "./server.js";
import { CONFIG_PATH, _resetConfig } from "./lib/config.js";

const ENV_KEYS = ["QDRANT_URL", "QDRANT_API_KEY", "BIKKY_COLLECTION"];
const savedEnv: Record<string, string | undefined> = {};
let savedConfig: string | null = null;
let configExisted = false;
const realFetch = globalThis.fetch;

describe("ui/server", () => {
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

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("/health reports qdrant_configured: false when not configured", async () => {
    fs.writeFileSync(CONFIG_PATH, "{}");
    _resetConfig();
    const app = createApp();

    const res = await app.fetch(new Request("http://localhost/health"));
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; service: string; qdrant_configured: boolean; collection: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "bikky-ui");
    assert.equal(body.qdrant_configured, false);
    assert.equal(typeof body.collection, "string");
  });

  it("/health reports qdrant_configured: true when env vars set", async () => {
    process.env.QDRANT_URL = "https://q.example:6333";
    process.env.QDRANT_API_KEY = "k";
    _resetConfig();
    const app = createApp();

    const res = await app.fetch(new Request("http://localhost/health"));
    const body = await res.json() as { qdrant_configured: boolean };
    assert.equal(body.qdrant_configured, true);
  });

  it("/api/memory/search returns 400 when q is missing", async () => {
    fs.writeFileSync(CONFIG_PATH, "{}");
    _resetConfig();
    const app = createApp();

    const res = await app.fetch(new Request("http://localhost/api/memory/search"));
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /Missing query/);
  });

  it("maps QdrantNotConfiguredError to 503 with NOT_CONFIGURED code", async () => {
    fs.writeFileSync(CONFIG_PATH, "{}"); // no qdrant creds
    _resetConfig();
    const app = createApp();

    // /api/memory/browse hits createQdrantClient() which throws QdrantNotConfiguredError
    const res = await app.fetch(new Request("http://localhost/api/memory/browse"));
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string; code: string };
    assert.equal(body.code, "NOT_CONFIGURED");
    assert.match(body.error, /Qdrant not configured/);
  });

  it("returns a non-API response for unknown paths (SPA fallback or 404)", async () => {
    fs.writeFileSync(CONFIG_PATH, "{}");
    _resetConfig();
    const app = createApp();

    const res = await app.fetch(new Request("http://localhost/non-existent-page"));
    // Either the SPA fallback (200 + text) or 404 — both acceptable when public/ may or may not exist.
    assert.ok([200, 404].includes(res.status), `unexpected status ${res.status}`);
  });
});
