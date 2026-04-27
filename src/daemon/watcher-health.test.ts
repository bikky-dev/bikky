/**
 * Tests for watcher-health (issue #58).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { looksLikeTempdir, inspectWatcherPaths, formatIssue, repairSuspiciousWatcherPaths } from "./watcher-health.js";
import { CONFIG_DEFAULTS } from "../config.js";

describe("looksLikeTempdir", () => {
  it("flags /tmp paths", () => {
    assert.strictEqual(looksLikeTempdir("/tmp/foo"), true);
  });
  it("flags /var/folders paths (macOS)", () => {
    assert.strictEqual(looksLikeTempdir("/var/folders/0z/abc/T/bikky-test-sessions-XYZ"), true);
  });
  it("flags os.tmpdir() prefixed paths", () => {
    assert.strictEqual(looksLikeTempdir(path.join(os.tmpdir(), "anything")), true);
  });
  it("flags bikky-test-* names anywhere", () => {
    assert.strictEqual(looksLikeTempdir("/Users/x/bikky-test-sessions-foo"), true);
  });
  it("does not flag canonical home paths", () => {
    assert.strictEqual(looksLikeTempdir(path.join(os.homedir(), ".copilot", "session-state")), false);
  });
  it("returns false for empty string", () => {
    assert.strictEqual(looksLikeTempdir(""), false);
  });
});

describe("inspectWatcherPaths", () => {
  it("returns empty when both watchers point at canonical defaults", () => {
    const cfg = structuredClone(CONFIG_DEFAULTS);
    const issues = inspectWatcherPaths(cfg);
    assert.strictEqual(issues.length, 0);
  });

  it("flags non-default tempdir paths", () => {
    const cfg = structuredClone(CONFIG_DEFAULTS);
    cfg.watchers.copilot.path = "/var/folders/0z/abc/T/bikky-test-sessions-XYZ/mixed-sessions";
    const issues = inspectWatcherPaths(cfg);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].watcher, "copilot");
    assert.ok(issues[0].reasons.some(r => r.includes("tempdir")));
  });

  it("flags non-default missing paths", () => {
    const cfg = structuredClone(CONFIG_DEFAULTS);
    cfg.watchers.copilot.path = "/nonexistent/path/for/test/abc123xyz";
    const issues = inspectWatcherPaths(cfg);
    assert.strictEqual(issues.length, 1);
    assert.ok(issues[0].reasons.some(r => r.includes("does not exist")));
  });

  it("does NOT flag a non-default but valid path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-valid-"));
    try {
      const cfg = structuredClone(CONFIG_DEFAULTS);
      // Custom path that exists — but it IS a tempdir, so it WILL be flagged.
      // To test the "valid" case, pick a real homedir path.
      cfg.watchers.copilot.path = path.join(os.homedir());
      const issues = inspectWatcherPaths(cfg);
      assert.strictEqual(issues.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores disabled watchers", () => {
    const cfg = structuredClone(CONFIG_DEFAULTS);
    cfg.watchers.copilot.enabled = false;
    cfg.watchers.copilot.path = "/var/folders/whatever/bikky-test-bad";
    const issues = inspectWatcherPaths(cfg);
    assert.strictEqual(issues.length, 0);
  });

  it("does NOT flag missing default paths (e.g. user without Claude installed)", () => {
    const cfg = structuredClone(CONFIG_DEFAULTS);
    // Both default paths — claude almost certainly absent in CI; that's fine.
    const issues = inspectWatcherPaths(cfg);
    for (const i of issues) {
      assert.notStrictEqual(i.watcher, "claude", `claude default path should not be flagged: ${JSON.stringify(i)}`);
    }
  });
});

describe("repairSuspiciousWatcherPaths", () => {
  it("resets enabled tempdir watcher paths to canonical defaults", () => {
    const cfg = structuredClone(CONFIG_DEFAULTS);
    const stalePath = "/var/folders/0z/abc/T/bikky-test-sessions-XYZ/mixed-sessions";
    cfg.watchers.copilot.path = stalePath;

    const repairs = repairSuspiciousWatcherPaths(cfg);

    assert.strictEqual(repairs.length, 1);
    assert.strictEqual(repairs[0].watcher, "copilot");
    assert.strictEqual(repairs[0].previousPath, stalePath);
    assert.strictEqual(repairs[0].repairedPath, CONFIG_DEFAULTS.watchers.copilot.path);
    assert.strictEqual(cfg.watchers.copilot.path, CONFIG_DEFAULTS.watchers.copilot.path);
  });

  it("does not rewrite disabled or non-temp custom watcher paths", () => {
    const cfg = structuredClone(CONFIG_DEFAULTS);
    cfg.watchers.copilot.enabled = false;
    cfg.watchers.copilot.path = "/tmp/bikky-test-disabled";
    cfg.watchers.claude.path = os.homedir();

    const repairs = repairSuspiciousWatcherPaths(cfg);

    assert.strictEqual(repairs.length, 0);
    assert.strictEqual(cfg.watchers.copilot.path, "/tmp/bikky-test-disabled");
    assert.strictEqual(cfg.watchers.claude.path, os.homedir());
  });
});

describe("formatIssue", () => {
  it("includes path, reasons, default, and fix instruction", () => {
    const msg = formatIssue({
      watcher: "copilot",
      configuredPath: "/tmp/bad",
      reasons: ["a", "b"],
      canonicalDefault: "/Users/x/.copilot/session-state",
    });
    assert.ok(msg.includes("/tmp/bad"));
    assert.ok(msg.includes("a; b"));
    assert.ok(msg.includes("/Users/x/.copilot/session-state"));
    assert.ok(msg.includes("fix:"));
  });
});
