/**
 * Tests for the MCP config installer.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { writeInstallConfig } from "./install.js";

const serverEntry = {
  type: "stdio",
  command: "npx",
  args: ["-y", "bikky", "mcp"],
};

let tempHome: string;
let originalPath: string | undefined;

function copilotConfigPath(): string {
  return path.join(tempHome, ".copilot", "mcp-config.json");
}

function claudeConfigPath(): string {
  return path.join(tempHome, ".claude.json");
}

function legacyClaudeConfigPath(): string {
  return path.join(tempHome, ".claude", "mcp.json");
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

function assertBikkyEntry(config: Record<string, unknown>): void {
  const mcpServers = config.mcpServers as Record<string, typeof serverEntry>;
  assert.ok(mcpServers);
  assert.deepStrictEqual(mcpServers.bikky, serverEntry);
}

function installWithoutClaudeCli(): Promise<void> {
  return writeInstallConfig({ homeDir: tempHome, claudeCommand: null });
}

function installWithMissingClaudeCli(): Promise<void> {
  return writeInstallConfig({ homeDir: tempHome, claudeCommand: "__bikky_missing_claude_test__" });
}

function addFakeClaudeToPath(exitCode = 0, stderr = ""): string {
  const binDir = path.join(tempHome, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const claudePath = path.join(binDir, "claude");
  fs.writeFileSync(
    claudePath,
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(path.join(process.env.HOME, "claude-args.json"), JSON.stringify(args, null, 2) + "\\n");
if (${exitCode} !== 0) {
  if (${JSON.stringify(stderr)}) console.error(${JSON.stringify(stderr)});
  process.exit(${exitCode});
}
const name = args[args.length - 2];
const entry = JSON.parse(args[args.length - 1]);
const configPath = path.join(process.env.HOME, ".claude.json");
let config = {};
if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
config.mcpServers ||= {};
config.mcpServers[name] = entry;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return claudePath;
}

describe("writeInstallConfig", () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-install-test-"));
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("writes to copilot mcp-config.json", async () => {
    await installWithoutClaudeCli();

    assert.ok(fs.existsSync(copilotConfigPath()));
    assertBikkyEntry(readJson(copilotConfigPath()));
  });

  it("registers Claude Code with its user config through the claude CLI when available", async () => {
    addFakeClaudeToPath();

    await writeInstallConfig({ homeDir: tempHome });

    assertBikkyEntry(readJson(claudeConfigPath()));
    assert.deepStrictEqual(
      readJson(path.join(tempHome, "claude-args.json")),
      ["mcp", "add-json", "-s", "user", "bikky", JSON.stringify(serverEntry)],
    );
    assert.equal(fs.existsSync(legacyClaudeConfigPath()), false);
  });

  it("falls back to ~/.claude.json when the Claude Code CLI is unavailable", async () => {
    await installWithMissingClaudeCli();

    assert.ok(fs.existsSync(claudeConfigPath()));
    assertBikkyEntry(readJson(claudeConfigPath()));
    assert.equal(fs.existsSync(legacyClaudeConfigPath()), false);
  });

  it("falls back to ~/.claude.json when Claude Code CLI registration fails", async () => {
    addFakeClaudeToPath(1);

    await writeInstallConfig({ homeDir: tempHome });

    assert.ok(fs.existsSync(claudeConfigPath()));
    assertBikkyEntry(readJson(claudeConfigPath()));
  });

  it("refreshes ~/.claude.json without warning when Claude Code says the server already exists", async () => {
    addFakeClaudeToPath(1, "MCP server bikky already exists in user config");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      await writeInstallConfig({ homeDir: tempHome });
    } finally {
      console.warn = originalWarn;
    }

    assert.deepStrictEqual(warnings, []);
    assert.ok(fs.existsSync(claudeConfigPath()));
    assertBikkyEntry(readJson(claudeConfigPath()));
  });

  it("preserves existing mcpServers in copilot config", async () => {
    fs.mkdirSync(path.dirname(copilotConfigPath()), { recursive: true });
    fs.writeFileSync(
      copilotConfigPath(),
      JSON.stringify({
        mcpServers: {
          "other-tool": { command: "other", args: ["--flag"] },
        },
      }),
    );

    await installWithoutClaudeCli();

    const config = readJson(copilotConfigPath());
    const mcpServers = config.mcpServers as Record<string, { command: string; args?: string[] }>;
    assert.deepStrictEqual(mcpServers["other-tool"], { command: "other", args: ["--flag"] });
    assert.deepStrictEqual(mcpServers.bikky, serverEntry);
  });

  it("preserves existing Claude Code user config fields and servers in fallback mode", async () => {
    fs.writeFileSync(
      claudeConfigPath(),
      JSON.stringify({
        firstStartTime: "2026-05-04T00:00:00.000Z",
        mcpServers: {
          "existing-server": { type: "stdio", command: "existing", args: [] },
        },
      }),
    );

    await installWithoutClaudeCli();

    const config = readJson(claudeConfigPath());
    const mcpServers = config.mcpServers as Record<string, unknown>;
    assert.equal(config.firstStartTime, "2026-05-04T00:00:00.000Z");
    assert.deepStrictEqual(mcpServers["existing-server"], {
      type: "stdio",
      command: "existing",
      args: [],
    });
    assert.deepStrictEqual(mcpServers.bikky, serverEntry);
  });

  it("overwrites existing bikky entry on re-run", async () => {
    await installWithoutClaudeCli();
    await installWithoutClaudeCli();

    assertBikkyEntry(readJson(copilotConfigPath()));
    assertBikkyEntry(readJson(claudeConfigPath()));
  });

  it("handles malformed existing config files", async () => {
    fs.mkdirSync(path.dirname(copilotConfigPath()), { recursive: true });
    fs.writeFileSync(copilotConfigPath(), "not valid json!!!");
    fs.writeFileSync(claudeConfigPath(), "not valid json!!!");

    await installWithoutClaudeCli();

    assertBikkyEntry(readJson(copilotConfigPath()));
    assertBikkyEntry(readJson(claudeConfigPath()));
  });
});
