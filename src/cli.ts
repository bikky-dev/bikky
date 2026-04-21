/**
 * mem00 CLI — setup, start MCP server, manage daemon.
 *
 * Usage:
 *   mem00 mcp        — start MCP server (stdio, for editor integration)
 *   mem00 daemon     — start background daemon (extraction, consolidation, etc.)
 *   mem00 setup      — interactive setup wizard
 *   mem00 status     — check memory system status
 *   mem00 install    — write MCP config for Copilot / Claude Code
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
      console.log("🧠 mem00 daemon starting…");
      await daemon.startDaemon();
      process.on("SIGINT", () => {
        daemon.stopDaemon();
        process.exit(0);
      });
      break;
    }

    case "setup":
      console.log("🧠 mem00 setup");
      console.log("Run `mem00 install` to add to your editor's MCP config.");
      console.log("Then call configure_credentials from your editor to set up Qdrant.");
      break;

    case "status":
      console.log("🧠 mem00 status — use get_setup_status via MCP for full details.");
      break;

    case "install": {
      const { writeInstallConfig } = await import("./install.js");
      await writeInstallConfig();
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: mem00 [mcp|daemon|setup|status|install]");
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error("Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
