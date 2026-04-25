/**
 * Tests for the rotating file logger.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createLogger } from "./logger.js";

describe("logger", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-logger-"));
    file = path.join(dir, "nested", "test.log");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the parent directory and writes a line", () => {
    const log = createLogger("svc", file);
    log("INFO", "hello", { a: 1 });

    const contents = fs.readFileSync(file, "utf-8");
    assert.match(contents, /\[svc\] INFO: hello \{"a":1\}/);
    assert.match(contents, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
  });

  it("respects all log levels", () => {
    const log = createLogger("svc", file);
    log("DEBUG", "d");
    log("INFO", "i");
    log("WARN", "w");
    log("ERROR", "e");

    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[0]!, /DEBUG: d$/);
    assert.match(lines[1]!, /INFO: i$/);
    assert.match(lines[2]!, /WARN: w$/);
    assert.match(lines[3]!, /ERROR: e$/);
  });

  it("rotates when the file exceeds maxSize", () => {
    const log = createLogger("svc", file, { maxSize: 200, maxFiles: 3 });
    for (let i = 0; i < 20; i++) log("INFO", "x".repeat(40));

    assert.ok(fs.existsSync(file), "active log file exists");
    assert.ok(fs.existsSync(`${file}.1`), "rotated file .1 exists");
    // Active file is smaller than the rotated one (was reset on rotate)
    const active = fs.statSync(file).size;
    const rotated = fs.statSync(`${file}.1`).size;
    assert.ok(active <= rotated);
  });

  it("caps the number of rotated files at maxFiles", () => {
    const log = createLogger("svc", file, { maxSize: 100, maxFiles: 2 });
    for (let i = 0; i < 50; i++) log("INFO", "x".repeat(40));

    // maxFiles=2 → keep .1 only (the active file plus one rotation slot)
    assert.ok(fs.existsSync(`${file}.1`));
    assert.ok(!fs.existsSync(`${file}.3`), "should not keep .3");
  });

  it("appends to an existing log file", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "PREEXISTING\n");

    const log = createLogger("svc", file);
    log("INFO", "after");

    const contents = fs.readFileSync(file, "utf-8");
    assert.ok(contents.startsWith("PREEXISTING\n"));
    assert.match(contents, /INFO: after/);
  });

  it("serialises non-string args via JSON.stringify", () => {
    const log = createLogger("svc", file);
    log("INFO", "msg", [1, 2], { x: "y" }, 42);

    const contents = fs.readFileSync(file, "utf-8");
    assert.match(contents, /msg \[1,2\] \{"x":"y"\} 42/);
  });
});
