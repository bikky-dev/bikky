/**
 * bikky CLI — setup, start MCP server, manage daemon.
 *
 * Usage:
 *   bikky start      — install MCP configs + start background daemon
 *   bikky stop       — stop background daemon
 *   bikky mcp        — start MCP server (stdio, for editor integration)
 *   bikky daemon     — start daemon in foreground (for debugging)
 *   bikky setup      — interactive setup wizard
 *   bikky status     — check memory system status
 *   bikky install    — write MCP config for Copilot / Claude Code
 *   bikky --version  — print version
 */

import fs from "node:fs";
import path from "node:path";
import { startMcpServer } from "./mcp/index.js";
import { getDaemonStatus, startAll, killDaemon } from "./lifecycle.js";

const command = process.argv[2] ?? "mcp";

function printVersion(): void {
  try {
    const pkgPath = new URL("../package.json", import.meta.url).pathname;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string };
    console.log(`bikky v${pkg.version}`);
  } catch {
    // Fallback: walk up from dist/ to find package.json
    const alt = path.resolve(new URL(".", import.meta.url).pathname, "..", "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(alt, "utf-8")) as { version: string };
      console.log(`bikky v${pkg.version}`);
    } catch {
      console.log("bikky (unknown version)");
    }
  }
}

async function main(): Promise<void> {
  if (command === "--version" || command === "-v") {
    printVersion();
    return;
  }

  switch (command) {
    case "start":
      await startAll();
      break;

    case "stop": {
      const killed = killDaemon();
      if (killed) {
        console.log("🛑 Daemon stopped.");
      } else {
        console.log("ℹ️  No daemon running.");
      }
      break;
    }

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
      console.log("Run `bikky start` to install MCP configs and start the daemon.");
      console.log("Then call configure_credentials from your editor to set up Qdrant.");
      break;

    case "status": {
      const status = getDaemonStatus();
      printVersion();
      console.log(`Daemon: ${status.running ? `🟢 running (PID ${status.pid})` : "🔴 stopped"}`);
      console.log("MCP:    managed by your editor (stdio)");
      console.log("\nRun `bikky start` to launch everything.");
      break;
    }

    case "install": {
      const { writeInstallConfig } = await import("./install.js");
      await writeInstallConfig();
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: bikky [start|stop|mcp|daemon|setup|status|install|--version]");
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error("Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
