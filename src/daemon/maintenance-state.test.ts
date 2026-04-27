import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-maint-state-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const {
  MAINTENANCE_STATE_PATH,
  defaultMaintenanceState,
  isAttemptBackedOff,
  pruneRecentAttempts,
  readMaintenanceState,
  recordMaintenanceRun,
  shouldRunMaintenance,
} = await import("./maintenance-state.js");

describe("daemon/maintenance-state", () => {
  beforeEach(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
  });

  it("starts with default job states", () => {
    assert.deepEqual(readMaintenanceState(), defaultMaintenanceState());
  });

  it("uses wall-clock intervals to decide whether a job should run", () => {
    const now = new Date("2026-04-27T10:00:00.000Z");

    assert.equal(shouldRunMaintenance(now, null, 900), true);
    assert.equal(shouldRunMaintenance(now, "2026-04-27T09:50:00.000Z", 900), false);
    assert.equal(shouldRunMaintenance(now, "2026-04-27T09:40:00.000Z", 900), true);
    assert.equal(shouldRunMaintenance(now, "not-a-date", 900), true);
    assert.equal(shouldRunMaintenance(now, "2026-04-27T09:59:59.000Z", 0), true);
  });

  it("records run summaries and cursors", () => {
    recordMaintenanceRun("entity_typing", {
      job: "entity_typing",
      ran_at: "2026-04-27T10:00:00.000Z",
      status: "success",
      candidates_seen: 2,
      llm_calls: 1,
      accepted: 2,
      deterministic: 1,
    }, { cursorUpdatedAt: "2026-04-27T09:59:00.000Z" });

    const state = readMaintenanceState();
    assert.ok(fs.existsSync(MAINTENANCE_STATE_PATH));
    assert.equal(state.jobs.entity_typing.last_run_at, "2026-04-27T10:00:00.000Z");
    assert.equal(state.jobs.entity_typing.cursor_updated_at, "2026-04-27T09:59:00.000Z");
    assert.equal(state.jobs.entity_typing.last_summary?.accepted, 2);
  });

  it("prunes and checks recent attempt backoff windows", () => {
    const now = new Date("2026-04-27T10:00:00.000Z");
    const attempts = {
      fresh: "2026-04-27T09:59:00.000Z",
      old: "2026-04-20T09:59:00.000Z",
      bad: "not-a-date",
    };

    assert.equal(isAttemptBackedOff(attempts, "fresh", now, 5 * 60 * 1000), true);
    assert.equal(isAttemptBackedOff(attempts, "old", now, 5 * 60 * 1000), false);
    assert.deepEqual(pruneRecentAttempts(attempts, now, 24 * 60 * 60 * 1000), { fresh: attempts.fresh });
  });
});
