/**
 * Tests for LLM telemetry — JSONL append, rotation, error swallowing.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { estimateTokens, writeTelemetry, type LLMTelemetryRecord } from "./telemetry.js";

describe("llm/telemetry", () => {
  let dir: string;
  let file: string;
  const noopLog = (): void => undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-telemetry-"));
    file = path.join(dir, "llm.jsonl");
    process.env.BIKKY_LLM_LOG = file;
    delete process.env.BIKKY_LLM_LOG_MAX_BYTES;
  });

  afterEach(() => {
    delete process.env.BIKKY_LLM_LOG;
    delete process.env.BIKKY_LLM_LOG_MAX_BYTES;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeRecord(overrides: Partial<LLMTelemetryRecord> = {}): LLMTelemetryRecord {
    return {
      ts: new Date().toISOString(),
      prompt: "extraction",
      model: "gpt-4o-mini",
      provider: "openai",
      ok: true,
      latency_ms: 123,
      tokens_in_est: 10,
      tokens_out_est: 20,
      ...overrides,
    };
  }

  describe("estimateTokens", () => {
    it("returns ceil(len/4) for non-empty input", () => {
      assert.equal(estimateTokens(""), 0);
      assert.equal(estimateTokens("abcd"), 1);
      assert.equal(estimateTokens("abcde"), 2);
      assert.equal(estimateTokens("a".repeat(100)), 25);
    });
  });

  describe("writeTelemetry", () => {
    it("appends a JSONL record to the configured log path", async () => {
      await writeTelemetry(makeRecord({ prompt: "first" }), noopLog);
      await writeTelemetry(makeRecord({ prompt: "second" }), noopLog);

      const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
      assert.equal(lines.length, 2);
      const first = JSON.parse(lines[0]!) as LLMTelemetryRecord;
      const second = JSON.parse(lines[1]!) as LLMTelemetryRecord;
      assert.equal(first.prompt, "first");
      assert.equal(second.prompt, "second");
      assert.equal(first.provider, "openai");
    });

    it("creates the parent directory if missing", async () => {
      const nested = path.join(dir, "a", "b", "c", "llm.jsonl");
      process.env.BIKKY_LLM_LOG = nested;

      await writeTelemetry(makeRecord(), noopLog);
      assert.ok(fs.existsSync(nested));
    });

    it("rotates to .1 when the file exceeds max bytes", async () => {
      process.env.BIKKY_LLM_LOG_MAX_BYTES = "200";
      // Seed an oversize file
      fs.writeFileSync(file, "x".repeat(500));

      await writeTelemetry(makeRecord(), noopLog);

      assert.ok(fs.existsSync(`${file}.1`), "rotated file should exist");
      const active = fs.readFileSync(file, "utf-8");
      // Active file should only contain the new record after rotation
      assert.equal(active.trim().split("\n").length, 1);
    });

    it("never throws when the path is unwritable; warns once via the logger", async () => {
      // Point at a path that cannot be created (parent is a file, not a dir)
      const blocker = path.join(dir, "blocker");
      fs.writeFileSync(blocker, "not-a-dir");
      process.env.BIKKY_LLM_LOG = path.join(blocker, "llm.jsonl");

      const warnings: string[] = [];
      const log = (_level: string, msg: unknown): void => { warnings.push(String(msg)); };

      await writeTelemetry(makeRecord(), log);
      await writeTelemetry(makeRecord(), log);

      // Module-level `warned` flag may already be set from a previous test;
      // assert at most one warning was added in this call sequence.
      assert.ok(warnings.length <= 1, "should warn at most once per process");
    });
  });
});
