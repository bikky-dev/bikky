/**
 * Write MCP config entries for Copilot and/or Claude Code.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

interface McpServerEntry {
  command: string;
  args?: string[];
  type?: string;
}

interface CopilotMcpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

interface ClaudeMcpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface InstallOptions {
  homeDir?: string;
  /**
   * Defaults to `claude`. Set to null to skip the Claude Code CLI and write the
   * user config file directly.
   */
  claudeCommand?: string | null;
}

const SERVER_NAME = "bikky";

function readJsonConfig<T extends object>(filePath: string): T {
  if (!fs.existsSync(filePath)) return {} as T;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return {} as T;
  }
}

function writeJsonConfig(filePath: string, config: object): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
}

function writeCopilotConfig(homeDir: string, entry: McpServerEntry): void {
  const copilotConfigPath = path.join(homeDir, ".copilot", "mcp-config.json");
  const config = readJsonConfig<CopilotMcpConfig>(copilotConfigPath);
  config.mcpServers ??= {};
  config.mcpServers[SERVER_NAME] = entry;

  writeJsonConfig(copilotConfigPath, config);
  console.log(`✅ Written to ${copilotConfigPath}`);
}

function registerClaudeWithCli(homeDir: string, entry: McpServerEntry, command: string): boolean {
  const result = spawnSync(
    command,
    ["mcp", "add-json", "-s", "user", SERVER_NAME, JSON.stringify(entry)],
    {
      env: { ...process.env, HOME: homeDir },
      encoding: "utf-8",
      stdio: "pipe",
    },
  );

  if (result.status === 0) {
    console.log(`✅ Registered ${SERVER_NAME} with Claude Code user config`);
    return true;
  }

  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    return false;
  }

  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (/already exists/i.test(stderr)) {
    return false;
  }

  const detail = stderr ? `: ${stderr}` : "";
  console.warn(`⚠️  Claude Code CLI registration failed${detail}`);
  return false;
}

function writeClaudeCodeUserConfig(homeDir: string, entry: McpServerEntry): void {
  const claudeConfigPath = path.join(homeDir, ".claude.json");
  const config = readJsonConfig<ClaudeMcpConfig>(claudeConfigPath);
  config.mcpServers ??= {};
  config.mcpServers[SERVER_NAME] = entry;

  writeJsonConfig(claudeConfigPath, config);
  console.log(`✅ Written to ${claudeConfigPath}`);
}

export async function writeInstallConfig(options: InstallOptions = {}): Promise<void> {
  const homeDir = options.homeDir ?? os.homedir();
  const entry: McpServerEntry = {
    type: "stdio",
    command: "npx",
    args: ["-y", "bikky", "mcp"],
  };

  writeCopilotConfig(homeDir, entry);

  const claudeCommand = options.claudeCommand === undefined ? "claude" : options.claudeCommand;
  const registeredWithClaudeCli = claudeCommand
    ? registerClaudeWithCli(homeDir, entry, claudeCommand)
    : false;
  if (!registeredWithClaudeCli) {
    writeClaudeCodeUserConfig(homeDir, entry);
  }

  console.log("\n🧠 bikky is now registered. Restart your editor to activate.");
}
