/**
 * Tests for read-only `bikky status` diagnostics.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-home-status-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const { CONFIG_PATH, resetConfig } = await import("./config.js");
const { QDRANT_INDEXES } = await import("./mcp/taxonomy.js");
const { collectStatus, formatStatusReport, sanitizeStatusUrl, statusExitCode } = await import("./status.js");

const realFetch = globalThis.fetch;

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function installStatusFetch(opts: {
  vectorSize?: number;
  missingIndex?: string;
  collectionVectorSize?: number;
} = {}): void {
  const vectorSize = opts.vectorSize ?? 1024;
  const payload_schema = Object.fromEntries(
    QDRANT_INDEXES
      .filter((idx) => idx.field_name !== opts.missingIndex)
      .map((idx) => [idx.field_name, { data_type: idx.field_schema }]),
  );

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/collections")) {
      return new Response(JSON.stringify({ result: { collections: [{ name: "bikky" }] } }), { status: 200 });
    }
    if (url.endsWith("/collections/bikky")) {
      return new Response(JSON.stringify({
        result: {
          points_count: 12,
          vectors_count: 12,
          payload_schema,
          config: {
            params: {
              vectors: { size: opts.collectionVectorSize ?? vectorSize, distance: "Cosine" },
            },
          },
        },
      }), { status: 200 });
    }
    if (url.endsWith("/v1/embeddings")) {
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: vectorSize }, () => 0.1) }],
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("status diagnostics", () => {
  before(() => {
    process.env.BIKKY_HOME = TEST_BIKKY_HOME;
  });

  after(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetConfig();
    globalThis.fetch = realFetch;
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_API_KEY;
    delete process.env.BIKKY_COLLECTION;
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_DIMENSIONS;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_BASE_URL;
  });

  it("surfaces corrupt config instead of looking like defaults", async () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, "{not-json");

    const report = await collectStatus({ live: false, checkUi: false });

    assert.equal(report.ok, false);
    assert.equal(report.config.status, "error");
    assert.ok(report.config.parse_error);
    assert.equal(statusExitCode(report), 1);
  });

  it("reports missing payload indexes without failing overall health", async () => {
    writeConfig({
      qdrant_url: "https://qdrant.test",
      collection: "bikky",
      embedding: {
        provider: "ollama",
        model: "qwen3-embedding:0.6b",
        dimensions: 1024,
        base_url: "http://localhost:11434",
      },
      llm: {
        provider: "ollama",
        model: "qwen2.5:7b",
        base_url: "http://localhost:11434",
      },
    });
    installStatusFetch({ missingIndex: "entities" });

    const report = await collectStatus({ live: true, checkUi: false });

    assert.equal(report.ok, true);
    assert.equal(report.qdrant.status, "warn");
    assert.deepEqual(report.qdrant.missing_indexes.map((idx) => idx.field_name), ["entities"]);
    assert.equal(report.embedding.status, "ok");
    assert.equal(report.embedding.live_checked, true);
    assert.match(formatStatusReport(report), /missing indexes: entities/);
  });

  it("fails when collection vector size differs from configured embedding dimensions", async () => {
    writeConfig({
      qdrant_url: "https://qdrant.test",
      collection: "bikky",
      embedding: {
        provider: "ollama",
        model: "qwen3-embedding:0.6b",
        dimensions: 1024,
        base_url: "http://localhost:11434",
      },
      llm: {
        provider: "ollama",
        model: "qwen2.5:7b",
        base_url: "http://localhost:11434",
      },
    });
    installStatusFetch({ collectionVectorSize: 1536 });

    const report = await collectStatus({ live: true, checkUi: false });

    assert.equal(report.ok, false);
    assert.equal(report.qdrant.status, "error");
    assert.match(report.qdrant.error ?? "", /does not match embedding dimensions/);
  });

  it("catches unknown providers before runtime memory operations", async () => {
    writeConfig({
      qdrant_url: "https://qdrant.test",
      collection: "bikky",
      embedding: { provider: "missing-embedder", model: "x", dimensions: 3 },
      llm: { provider: "missing-llm", model: "x" },
    });
    installStatusFetch({ vectorSize: 3 });

    const report = await collectStatus({ live: false, checkUi: false });

    assert.equal(report.ok, false);
    assert.equal(report.embedding.status, "error");
    assert.match(report.embedding.error ?? "", /Unknown embedding provider/);
    assert.equal(report.llm.status, "error");
    assert.match(report.llm.error ?? "", /Unknown inference provider/);
  });

  it("sanitizes credentials from URLs in reports", async () => {
    assert.equal(
      sanitizeStatusUrl("https://user:secret@example.com:6333/path?api_key=abc&ok=1"),
      "https://example.com:6333/path?api_key=REDACTED&ok=1",
    );

    writeConfig({
      qdrant_url: "https://qdrant.test",
      collection: "bikky",
      embedding: {
        provider: "ollama",
        model: "qwen3-embedding:0.6b",
        dimensions: 1024,
        base_url: "https://user:secret@embed.example/v1?token=abc",
      },
      llm: {
        provider: "ollama",
        model: "qwen2.5:7b",
        base_url: "https://user:secret@llm.example/v1?password=abc",
      },
    });
    installStatusFetch();

    const report = await collectStatus({ live: false, checkUi: false });

    assert.equal(report.embedding.base_url, "https://embed.example/v1?token=REDACTED");
    assert.equal(report.llm.base_url, "https://llm.example/v1?password=REDACTED");
  });

  it("includes daemon maintenance summaries without making live calls", async () => {
    const stateDir = path.join(TEST_BIKKY_HOME, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "maintenance-state.json"), JSON.stringify({
      version: 1,
      jobs: {
        relation_inference: {
          last_run_at: "2026-04-27T10:00:00.000Z",
          cursor_updated_at: "2026-04-27T09:59:00.000Z",
          recent_attempts: {},
          last_summary: {
            job: "relation_inference",
            ran_at: "2026-04-27T10:00:00.000Z",
            status: "success",
            candidates_seen: 3,
            llm_calls: 2,
            accepted: 1,
          },
        },
        entity_typing: {
          last_run_at: null,
          cursor_updated_at: null,
          recent_attempts: {},
          last_summary: null,
        },
        memory_quality_rollups: {
          last_run_at: "2026-04-27T11:00:00.000Z",
          cursor_updated_at: "2026-04-27T11:00:00.000Z",
          recent_attempts: {},
          last_summary: {
            job: "memory_quality_rollups",
            ran_at: "2026-04-27T11:00:00.000Z",
            status: "success",
            candidates_seen: 7,
            llm_calls: 0,
            accepted: 4,
            deterministic: 4,
          },
        },
      },
    }));

    const report = await collectStatus({ live: false, checkUi: false });

    assert.equal(report.maintenance.status, "ok");
    assert.equal(report.maintenance.relation_inference.last_summary?.llm_calls, 2);
    assert.equal(report.maintenance.memory_quality_rollups.last_summary?.accepted, 4);
    assert.match(formatStatusReport(report), /Maint:/);
    assert.match(formatStatusReport(report), /relations: success/);
    assert.match(formatStatusReport(report), /quality rollups: success/);
  });
});
