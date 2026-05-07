/**
 * Tests for daemon lifecycle PID-file management.
 *
 * Uses BIKKY_HOME to keep PID-file reads/writes in an isolated tempdir so tests
 * never touch a user's real ~/.bikky/state/daemon.pid.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-lifecycle-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const { getDaemonStatus, killDaemon } = await import("./lifecycle.js");
const { getPidPath } = await import("./config.js");

function writePidFile(contents: string): string {
  const pidPath = getPidPath();
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, contents);
  return pidPath;
}

describe("lifecycle (PID file)", () => {
  before(() => {
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
  });

  it("uses BIKKY_HOME for PID file operations", () => {
    assert.equal(getPidPath(), path.join(TEST_BIKKY_HOME, "state", "daemon.pid"));
  });

  it("returns running:false when no PID file exists", () => {
    const status = getDaemonStatus();
    assert.deepEqual(status, { running: false, pid: null });
  });

  it("returns running:true when PID belongs to a live process", () => {
    writePidFile(String(process.pid));

    const status = getDaemonStatus();
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
  });

  it("returns running:false and cleans up a stale PID file", () => {
    // PID 999999 is virtually guaranteed not to exist
    const pidPath = writePidFile("999999");

    const status = getDaemonStatus();
    assert.deepEqual(status, { running: false, pid: null });
    assert.ok(!fs.existsSync(pidPath), "stale PID file should be removed");
  });

  it("treats unparseable PID file as 'no daemon'", () => {
    writePidFile("not-a-number\n");

    const status = getDaemonStatus();
    assert.equal(status.running, false);
    assert.equal(status.pid, null);
  });

  it("killDaemon returns false when no PID file exists", () => {
    assert.equal(killDaemon(), false);
  });

  it("killDaemon removes the PID file even for a stale entry", () => {
    const pidPath = writePidFile("999999");

    const result = killDaemon();
    assert.equal(result, true);
    assert.ok(!fs.existsSync(pidPath));
  });
});
