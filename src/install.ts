/**
 * Write MCP config entries for Copilot and/or Claude Code.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

export async function writeInstallConfig(): Promise<void> {
  const entry: McpServerEntry = {
    type: "stdio",
    command: "npx",
    args: ["-y", "bikky", "mcp"],
  };

  // Copilot MCP config
  const copilotConfigPath = path.join(os.homedir(), ".copilot", "mcp-config.json");

  let config: CopilotMcpConfig = {};
  if (fs.existsSync(copilotConfigPath)) {
    try {
      config = JSON.parse(fs.readFileSync(copilotConfigPath, "utf-8")) as CopilotMcpConfig;
    } catch {
      config = {};
    }
  }

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers["bikky"] = entry;

  fs.mkdirSync(path.dirname(copilotConfigPath), { recursive: true });
  fs.writeFileSync(copilotConfigPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`✅ Written to ${copilotConfigPath}`);

  // Claude Code MCP config
  const claudeConfigPath = path.join(os.homedir(), ".claude", "mcp.json");
  let claudeConfig: ClaudeMcpConfig = {};
  if (fs.existsSync(claudeConfigPath)) {
    try {
      claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8")) as ClaudeMcpConfig;
    } catch {
      claudeConfig = {};
    }
  }

  if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};
  claudeConfig.mcpServers["bikky"] = entry;

  fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
  fs.writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2) + "\n");
  console.log(`✅ Written to ${claudeConfigPath}`);

  console.log("\n🧠 bikky is now registered. Restart your editor to activate.");
}
