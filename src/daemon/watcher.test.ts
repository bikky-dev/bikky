/**
 * Tests for the session watcher.
 *
 * Creates a temporary directory structure mimicking ~/.copilot/session-state/
 * and verifies discoverSessions() behavior.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resetConfig, loadConfig, saveConfig, CONFIG_DEFAULTS } from "../config.js";
import { discoverSessions } from "./watcher.js";

// ---------------------------------------------------------------------------
// Test directory setup
// ---------------------------------------------------------------------------

let testDir: string;
let savedConfig: string | null = null;

function createTestDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bikky-test-sessions-"));
}

describe("discoverSessions", () => {
  before(() => {
    // Save existing config state
    const configPath = path.join(os.homedir(), ".bikky", "config.json");
    if (fs.existsSync(configPath)) {
      savedConfig = fs.readFileSync(configPath, "utf-8");
    }
    testDir = createTestDir();
  });

  after(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });

    // Restore original config
    const configPath = path.join(os.homedir(), ".bikky", "config.json");
    if (savedConfig !== null) {
      fs.writeFileSync(configPath, savedConfig);
    } else if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    resetConfig();
  });

  beforeEach(() => {
    resetConfig();
  });

  it("returns empty array when base dir does not exist", () => {
    const cfg = {
      ...CONFIG_DEFAULTS,
      watchers: {
        ...CONFIG_DEFAULTS.watchers,
        copilot: {
          enabled: true,
          path: path.join(testDir, "nonexistent"),
        },
      },
    };
    // Don't resetConfig — use cached config to avoid races with concurrent test files
    saveConfig(cfg);

    const sessions = discoverSessions();
    assert.deepStrictEqual(sessions, []);
  });

  it("returns empty array when directory exists but has no sessions", () => {
    const emptyDir = path.join(testDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    const cfg = {
      ...CONFIG_DEFAULTS,
      watchers: {
        ...CONFIG_DEFAULTS.watchers,
        copilot: { enabled: true, path: emptyDir },
      },
    };
    saveConfig(cfg);

    const sessions = discoverSessions();
    assert.deepStrictEqual(sessions, []);
  });

  it("discovers sessions with events.jsonl files", () => {
    const sessionsDir = path.join(testDir, "with-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const sessionDir = path.join(sessionsDir, sessionUuid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), '{"event":"test"}\n');

    const cfg = {
      ...CONFIG_DEFAULTS,
      watchers: {
        ...CONFIG_DEFAULTS.watchers,
        copilot: { enabled: true, path: sessionsDir },
      },
    };
    saveConfig(cfg);

    const sessions = discoverSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].uuid, sessionUuid);
    assert.ok(sessions[0].eventsPath.endsWith("events.jsonl"));
    assert.strictEqual(sessions[0].active, false);
  });

  it("marks sessions with lock files as active", () => {
    const sessionsDir = path.join(testDir, "active-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionUuid = "11111111-2222-3333-4444-555555555555";
    const sessionDir = path.join(sessionsDir, sessionUuid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), '{"event":"test"}\n');
    fs.writeFileSync(path.join(sessionDir, "inuse.12345.lock"), "");

    const cfg = {
      ...CONFIG_DEFAULTS,
      watchers: {
        ...CONFIG_DEFAULTS.watchers,
        copilot: { enabled: true, path: sessionsDir },
      },
    };
    saveConfig(cfg);

    const sessions = discoverSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].active, true);
  });

  it("detects both active and inactive sessions", () => {
    const sessionsDir = path.join(testDir, "mixed-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const activeUuid = "active-uuid-1111";
    const activeDir = path.join(sessionsDir, activeUuid);
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, "events.jsonl"), "");
    fs.writeFileSync(path.join(activeDir, "inuse.999.lock"), "");

    const inactiveUuid = "inactive-uuid-2222";
    const inactiveDir = path.join(sessionsDir, inactiveUuid);
    fs.mkdirSync(inactiveDir, { recursive: true });
    fs.writeFileSync(path.join(inactiveDir, "events.jsonl"), "");

    const cfg = {
      ...CONFIG_DEFAULTS,
      watchers: {
        ...CONFIG_DEFAULTS.watchers,
        copilot: { enabled: true, path: sessionsDir },
      },
    };
    saveConfig(cfg);

    const sessions = discoverSessions();
    assert.strictEqual(sessions.length, 2);

    const active = sessions.find((s) => s.uuid === activeUuid);
    const inactive = sessions.find((s) => s.uuid === inactiveUuid);
    assert.ok(active);
    assert.ok(inactive);
    assert.strictEqual(active.active, true);
    assert.strictEqual(inactive.active, false);
  });

  it("skips non-directory entries", () => {
    const sessionsDir = path.join(testDir, "with-files");
    fs.mkdirSync(sessionsDir, { recursive: true });

    fs.writeFileSync(path.join(sessionsDir, "not-a-dir.txt"), "");

    const sessionUuid = "valid-session-uuid";
    const sessionDir = path.join(sessionsDir, sessionUuid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), "");

    const cfg = {
      ...CONFIG_DEFAULTS,
      watchers: {
        ...CONFIG_DEFAULTS.watchers,
        copilot: { enabled: true, path: sessionsDir },
      },
    };
    saveConfig(cfg);

    const sessions = discoverSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].uuid, sessionUuid);
  });

  it("skips directories without events.jsonl", () => {
    const sessionsDir = path.join(testDir, "no-events");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const noEventsUuid = "no-events-uuid";
    const noEventsDir = path.join(sessionsDir, noEventsUuid);
    fs.mkdirSync(noEventsDir, { recursive: true });

    const withEventsUuid = "with-events-uuid";
    const withEventsDir = path.join(sessionsDir, withEventsUuid);
    fs.mkdirSync(withEventsDir, { recursive: true });
    fs.writeFileSync(path.join(withEventsDir, "events.jsonl"), "");

    const cfg = {
      ...CONFIG_DEFAULTS,
      watchers: {
        ...CONFIG_DEFAULTS.watchers,
        copilot: { enabled: true, path: sessionsDir },
      },
    };
    saveConfig(cfg);

    const sessions = discoverSessions();
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].uuid, withEventsUuid);
  });

  it("creates proper WatchedSession objects", () => {
    const sessionsDir = path.join(testDir, "proper-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionUuid = "proper-session-uuid";
    const sessionDir = path.join(sessionsDir, sessionUuid);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), "");

    const cfg = {
      ...CONFIG_DEFAULTS,
      watchers: {
        ...CONFIG_DEFAULTS.watchers,
        copilot: { enabled: true, path: sessionsDir },
      },
    };
    saveConfig(cfg);

    const sessions = discoverSessions();
    const session = sessions[0];

    assert.ok(session);
    assert.strictEqual(typeof session.uuid, "string");
    assert.strictEqual(typeof session.eventsPath, "string");
    assert.strictEqual(typeof session.active, "boolean");
    assert.strictEqual(session.uuid, sessionUuid);
    assert.strictEqual(session.eventsPath, path.join(sessionDir, "events.jsonl"));
  });
});
