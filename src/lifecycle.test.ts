/**
 * Tests for daemon lifecycle PID-file management.
 *
 * Backs up and restores the real PID file at ~/.bikky/state/daemon.pid so
 * we don't clobber an actual running daemon during the test run.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { getDaemonStatus, killDaemon } from "./lifecycle.js";
import { PID_PATH } from "./config.js";

let backup: string | null = null;

describe("lifecycle (PID file)", () => {
  before(() => {
    if (fs.existsSync(PID_PATH)) {
      backup = fs.readFileSync(PID_PATH, "utf-8");
    }
  });

  after(() => {
    if (backup !== null) {
      fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
      fs.writeFileSync(PID_PATH, backup);
    } else if (fs.existsSync(PID_PATH)) {
      fs.unlinkSync(PID_PATH);
    }
  });

  beforeEach(() => {
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  });

  afterEach(() => {
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  });

  it("returns running:false when no PID file exists", () => {
    const status = getDaemonStatus();
    assert.deepEqual(status, { running: false, pid: null });
  });

  it("returns running:true when PID belongs to a live process", () => {
    fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
    fs.writeFileSync(PID_PATH, String(process.pid));

    const status = getDaemonStatus();
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
  });

  it("returns running:false and cleans up a stale PID file", () => {
    // PID 999999 is virtually guaranteed not to exist
    fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
    fs.writeFileSync(PID_PATH, "999999");

    const status = getDaemonStatus();
    assert.deepEqual(status, { running: false, pid: null });
    assert.ok(!fs.existsSync(PID_PATH), "stale PID file should be removed");
  });

  it("treats unparseable PID file as 'no daemon'", () => {
    fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
    fs.writeFileSync(PID_PATH, "not-a-number\n");

    const status = getDaemonStatus();
    assert.equal(status.running, false);
    assert.equal(status.pid, null);
  });

  it("killDaemon returns false when no PID file exists", () => {
    assert.equal(killDaemon(), false);
  });

  it("killDaemon removes the PID file even for a stale entry", () => {
    fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
    fs.writeFileSync(PID_PATH, "999999");

    const result = killDaemon();
    assert.equal(result, true);
    assert.ok(!fs.existsSync(PID_PATH));
  });
});
