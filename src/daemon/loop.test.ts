import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { QDRANT_INDEXES } from "../mcp/taxonomy.js";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-daemon-loop-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const { CONFIG_DEFAULTS, resetConfig, saveConfig, getConfigPath } = await import("../config.js");
const { startDaemon, stopDaemon } = await import("./loop.js");

interface FetchCall {
  input: string | URL | Request;
  init?: RequestInit;
}

const configPath = path.join(TEST_BIKKY_HOME, "config.json");
const qdrantEnvKeys = ["QDRANT_URL", "QDRANT_API_KEY"] as const;

const savedQdrantEnv: Record<string, string | undefined> = {};
let savedFetch: typeof fetch;
let calls: FetchCall[] = [];

describe("daemon loop", () => {
  before(() => {
    savedFetch = globalThis.fetch;
    assert.equal(getConfigPath(), configPath);
    for (const key of qdrantEnvKeys) {
      savedQdrantEnv[key] = process.env[key];
    }
  });

  after(() => {
    stopDaemon();
    globalThis.fetch = savedFetch;
    for (const key of qdrantEnvKeys) {
      if (savedQdrantEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedQdrantEnv[key];
      }
    }
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    resetConfig();
  });

  beforeEach(() => {
    stopDaemon();
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
    calls = [];
    for (const key of qdrantEnvKeys) {
      delete process.env[key];
    }
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    resetConfig();
  });

  it("ensures the Qdrant collection and payload indexes at startup", async () => {
    saveConfig({
      ...CONFIG_DEFAULTS,
      qdrant_url: "https://qdrant.example.com:6333",
      qdrant_api_key: null,
      collection: "bikky-daemon-loop-test",
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        tick_interval_sec: 3600,
      },
    });
    resetConfig();

    try {
      await startDaemon();
    } finally {
      stopDaemon();
    }

    assert.equal(calls.length, 1 + QDRANT_INDEXES.length);
    assert.match(String(calls[0]?.input), /\/collections\/bikky-daemon-loop-test$/);

    const indexCalls = calls.slice(1);
    assert.equal(indexCalls.length, QDRANT_INDEXES.length);
    for (const [idx, call] of indexCalls.entries()) {
      assert.match(String(call.input), /\/collections\/bikky-daemon-loop-test\/index$/);
      assert.equal(call.init?.method, "PUT");
      assert.deepEqual(JSON.parse(String(call.init?.body)), QDRANT_INDEXES[idx]);
    }
  });
});
