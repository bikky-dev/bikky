/**
 * bikky CLI — setup, start MCP server, manage daemon.
 *
 * Usage:
 *   bikky mcp        — start MCP server (stdio, for editor integration)
 *   bikky daemon     — start background daemon (extraction, consolidation, etc.)
 *   bikky setup      — interactive setup wizard
 *   bikky status     — check memory system status
 *   bikky install    — write MCP config for Copilot / Claude Code
 */

import { startMcpServer } from "./mcp/index.js";

const command = process.argv[2] ?? "mcp";

async function main(): Promise<void> {
  switch (command) {
    case "mcp":
      await startMcpServer();
      break;

    case "daemon": {
      const daemon = await import("./daemon/index.js");
      console.log("🧠 bikky daemon starting…");
      await daemon.startDaemon();
      process.on("SIGINT", () => {
        daemon.stopDaemon();
        process.exit(0);
      });
      break;
    }

    case "setup":
      console.log("🧠 bikky setup");
      console.log("Run `bikky install` to add to your editor's MCP config.");
      console.log("Then call configure_credentials from your editor to set up Qdrant.");
      break;

    case "status":
      console.log("🧠 bikky status — use get_setup_status via MCP for full details.");
      break;

    case "install": {
      const { writeInstallConfig } = await import("./install.js");
      await writeInstallConfig();
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: bikky [mcp|daemon|setup|status|install]");
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error("Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
