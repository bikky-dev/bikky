/**
 * Tests for the pino-backed structured file logger.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createLogger } from "./logger.js";

interface LogLine {
  level: string;
  time: string;
  name: string;
  msg: string;
  [k: string]: unknown;
}

function readLines(file: string): LogLine[] {
  return fs
    .readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LogLine);
}

describe("logger (pino-backed)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-logger-"));
    file = path.join(dir, "nested", "test.log");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the parent directory and writes a JSON line with name + msg", () => {
    const log = createLogger("svc", file);
    log("INFO", "hello", { a: 1 });

    const lines = readLines(file);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.level, "info");
    assert.equal(lines[0]!.name, "svc");
    assert.equal(lines[0]!.msg, 'hello {"a":1}');
    assert.match(lines[0]!.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("maps DEBUG/INFO/WARN/ERROR levels to pino lowercase labels", () => {
    const log = createLogger("svc", file);
    log("DEBUG", "d");
    log("INFO", "i");
    log("WARN", "w");
    log("ERROR", "e");

    const lines = readLines(file);
    assert.equal(lines.length, 4);
    assert.deepEqual(
      lines.map((l) => [l.level, l.msg]),
      [
        ["debug", "d"],
        ["info", "i"],
        ["warn", "w"],
        ["error", "e"],
      ],
    );
  });

  it("merges a leading object arg as structured fields", () => {
    const log = createLogger("svc", file);
    log("INFO", { event: "embed_request", provider: "openai" }, "ok");

    const lines = readLines(file);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.event, "embed_request");
    assert.equal(lines[0]!.provider, "openai");
    assert.equal(lines[0]!.msg, "ok");
  });

  it("serialises non-string args into msg via JSON.stringify", () => {
    const log = createLogger("svc", file);
    log("INFO", "msg", [1, 2], 42);

    const lines = readLines(file);
    assert.equal(lines[0]!.msg, "msg [1,2] 42");
  });

  it("renders Error args via .message rather than {}", () => {
    const log = createLogger("svc", file);
    log("ERROR", "boom", new Error("kaboom"));

    const lines = readLines(file);
    assert.match(lines[0]!.msg, /boom kaboom/);
  });

  it("rotates when the file exceeds maxSize", () => {
    const log = createLogger("svc", file, { maxSize: 200, maxFiles: 3 });
    for (let i = 0; i < 50; i++) log("INFO", "x".repeat(80));

    assert.ok(fs.existsSync(file), "active log file exists");
    assert.ok(fs.existsSync(`${file}.1`), "rotated file .1 exists");
    const active = fs.statSync(file).size;
    const rotated = fs.statSync(`${file}.1`).size;
    assert.ok(active <= rotated);
  });

  it("caps the number of rotated files at maxFiles", () => {
    const log = createLogger("svc", file, { maxSize: 100, maxFiles: 2 });
    for (let i = 0; i < 100; i++) log("INFO", "x".repeat(80));

    assert.ok(fs.existsSync(`${file}.1`));
    assert.ok(!fs.existsSync(`${file}.3`), "should not keep .3");
  });

  it("appends to an existing log file", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"pre":"existing"}\n');

    const log = createLogger("svc", file);
    log("INFO", "after");

    const contents = fs.readFileSync(file, "utf-8");
    assert.ok(contents.startsWith('{"pre":"existing"}\n'));
    const lines = contents.trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]!) as LogLine;
    assert.equal(last.msg, "after");
  });
});
