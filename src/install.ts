/**
 * Write MCP config entries for Copilot and/or Claude Code.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { inferUserIdentity, type OriginIdentity } from "./provenance/origin.js";

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
  /**
   * Defaults to true. Set to false in tests or advanced flows that only want
   * MCP config files and do not want ~/.bikky/config.json touched.
   */
  provisionIdentity?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  hostname?: string;
  shellUsername?: string | null;
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

function bikkyConfigPath(homeDir: string, explicitHomeDir: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const bikkyDir = explicitHomeDir ? path.join(homeDir, ".bikky") : env.BIKKY_HOME ?? path.join(homeDir, ".bikky");
  return path.join(bikkyDir, "config.json");
}

function hasConfiguredValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function provisionUserIdentityConfig(options: InstallOptions = {}): OriginIdentity | null {
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = bikkyConfigPath(homeDir, options.homeDir !== undefined, options.env);
  const config = readJsonConfig<Record<string, unknown>>(configPath);
  const existingIdentity = config.identity && typeof config.identity === "object" && !Array.isArray(config.identity)
    ? config.identity as Record<string, unknown>
    : {};

  const hasUserId = hasConfiguredValue(existingIdentity.user_id);
  const hasUserName = hasConfiguredValue(existingIdentity.user_name);
  if (hasUserId && hasUserName) return null;

  const inferred = inferUserIdentity({
    env: options.env,
    cwd: options.cwd,
    hostname: options.hostname,
    shellUsername: options.shellUsername,
  });
  const nextIdentity: Record<string, unknown> = { ...existingIdentity };
  if (!hasUserId) nextIdentity.user_id = inferred.id;
  if (!hasUserName) nextIdentity.user_name = inferred.name;
  config.identity = nextIdentity;
  writeJsonConfig(configPath, config);
  console.log(`✅ Provisioned bikky user identity in ${configPath}`);
  return inferred;
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
  if (options.provisionIdentity !== false) {
    provisionUserIdentityConfig(options);
  }

  console.log("\n🧠 bikky is now registered.");
}
