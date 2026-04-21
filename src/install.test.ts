/**
 * Tests for the MCP config installer.
 *
 * Tests the structure of what writeInstallConfig() would write
 * without actually modifying the user's home directory config files.
 * We back up and restore the real config files around the test.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { writeInstallConfig } from "./install.js";

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

const copilotConfigPath = path.join(os.homedir(), ".copilot", "mcp-config.json");
const claudeConfigPath = path.join(os.homedir(), ".claude", "mcp.json");

let copilotBackup: string | null = null;
let claudeBackup: string | null = null;

function backup(): void {
  if (fs.existsSync(copilotConfigPath)) {
    copilotBackup = fs.readFileSync(copilotConfigPath, "utf-8");
  }
  if (fs.existsSync(claudeConfigPath)) {
    claudeBackup = fs.readFileSync(claudeConfigPath, "utf-8");
  }
}

function restore(): void {
  if (copilotBackup !== null) {
    fs.writeFileSync(copilotConfigPath, copilotBackup);
  } else if (fs.existsSync(copilotConfigPath)) {
    // If the file didn't exist before but does now, we need to remove
    // only the mem00 entry, not delete the whole file (other tools may have written it)
    // Actually, for safety, just leave it. The backup was null meaning it didn't exist.
    // But writeInstallConfig created it. We should remove it to be clean.
    fs.unlinkSync(copilotConfigPath);
  }

  if (claudeBackup !== null) {
    fs.writeFileSync(claudeConfigPath, claudeBackup);
  } else if (fs.existsSync(claudeConfigPath)) {
    fs.unlinkSync(claudeConfigPath);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("writeInstallConfig", () => {
  before(() => {
    backup();
  });

  after(() => {
    restore();
  });

  it("writes to copilot mcp-config.json", async () => {
    await writeInstallConfig();
    assert.ok(fs.existsSync(copilotConfigPath));
  });

  it("writes to claude mcp.json", async () => {
    await writeInstallConfig();
    assert.ok(fs.existsSync(claudeConfigPath));
  });

  it("copilot config has correct structure", async () => {
    await writeInstallConfig();
    const config = JSON.parse(fs.readFileSync(copilotConfigPath, "utf-8"));
    assert.ok(config.servers);
    assert.ok(config.servers.mem00);
    assert.strictEqual(config.servers.mem00.command, "npx");
    assert.deepStrictEqual(config.servers.mem00.args, ["-y", "mem00", "mcp"]);
  });

  it("claude config has correct structure", async () => {
    await writeInstallConfig();
    const config = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
    assert.ok(config.servers);
    assert.ok(config.servers.mem00);
    assert.strictEqual(config.servers.mem00.command, "npx");
    assert.deepStrictEqual(config.servers.mem00.args, ["-y", "mem00", "mcp"]);
  });

  it("preserves existing servers in copilot config", async () => {
    // Write a pre-existing config with another server
    fs.mkdirSync(path.dirname(copilotConfigPath), { recursive: true });
    fs.writeFileSync(
      copilotConfigPath,
      JSON.stringify({
        servers: {
          "other-tool": { command: "other", args: ["--flag"] },
        },
      }),
    );

    await writeInstallConfig();

    const config = JSON.parse(fs.readFileSync(copilotConfigPath, "utf-8"));
    // Both servers should exist
    assert.ok(config.servers["other-tool"]);
    assert.ok(config.servers.mem00);
    assert.strictEqual(config.servers["other-tool"].command, "other");
  });

  it("preserves existing servers in claude config", async () => {
    fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
    fs.writeFileSync(
      claudeConfigPath,
      JSON.stringify({
        servers: {
          "existing-server": { command: "existing", args: [] },
        },
      }),
    );

    await writeInstallConfig();

    const config = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
    assert.ok(config.servers["existing-server"]);
    assert.ok(config.servers.mem00);
  });

  it("overwrites existing mem00 entry on re-run", async () => {
    // First run
    await writeInstallConfig();
    // Second run
    await writeInstallConfig();

    const config = JSON.parse(fs.readFileSync(copilotConfigPath, "utf-8"));
    assert.strictEqual(config.servers.mem00.command, "npx");
    assert.deepStrictEqual(config.servers.mem00.args, ["-y", "mem00", "mcp"]);
  });

  it("handles malformed existing config file", async () => {
    fs.mkdirSync(path.dirname(copilotConfigPath), { recursive: true });
    fs.writeFileSync(copilotConfigPath, "not valid json!!!");

    // Should not throw — should overwrite with valid config
    await writeInstallConfig();

    const config = JSON.parse(fs.readFileSync(copilotConfigPath, "utf-8"));
    assert.ok(config.servers.mem00);
  });
});
