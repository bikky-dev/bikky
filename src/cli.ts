/**
 * bikky CLI — setup, start MCP server, manage daemon.
 *
 * Usage:
 *   bikky start      — install MCP configs + start background daemon
 *   bikky stop       — stop background daemon
 *   bikky mcp        — start MCP server (stdio, for editor integration)
 *   bikky daemon     — start daemon in foreground (for debugging)
 *   bikky setup      — install MCP configs + start daemon (alias for start)
 *   bikky status     — check memory system status
 *   bikky ui         — open memory explorer web UI
 *   bikky render     — render a prompt to JSON (for eval harnesses)
 *   bikky --version  — print version
 */

import fs from "node:fs";
import path from "node:path";
import { startMcpServer } from "./mcp/index.js";
import { startAll, killDaemon } from "./lifecycle.js";
import { runRenderCli } from "./render.js";
import { collectStatus, formatStatusReport, statusExitCode } from "./status.js";

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
      await startAll();
      break;

    case "status": {
      const args = process.argv.slice(3);
      const allowed = new Set(["--json", "--no-live", "--no-ui"]);
      const unknown = args.filter((arg) => !allowed.has(arg));
      if (unknown.length > 0) {
        console.error(`Unknown status option: ${unknown.join(", ")}`);
        console.error("Usage: bikky status [--json] [--no-live] [--no-ui]");
        process.exit(1);
      }

      const report = await collectStatus({
        live: !args.includes("--no-live"),
        checkUi: !args.includes("--no-ui"),
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printVersion();
        console.log("");
        console.log(formatStatusReport(report));
        if (!report.ok) {
          console.log("\nRun `bikky start` after fixing setup issues.");
        }
      }
      process.exitCode = statusExitCode(report);
      break;
    }

    case "render": {
      const code = await runRenderCli(process.argv.slice(3));
      process.exit(code);
    }

    case "ui": {
      const { execSync } = await import("node:child_process");
      console.log("🧠 Launching bikky ui…");
      try {
        execSync("npx --yes bikky-ui", { stdio: "inherit" });
      } catch {
        // User hit Ctrl+C or process exited
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: bikky [start|stop|mcp|daemon|setup|status|ui|render|--version]");
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error("Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
