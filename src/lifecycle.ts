/**
 * Daemon lifecycle — start/stop the daemon as a detached background process.
 *
 * - `startAll()` writes MCP configs + launches daemon with PID file
 * - `stopDaemon()` kills daemon via PID file
 * - `getDaemonStatus()` checks if daemon PID is alive
 */

import fs from "node:fs";
import { spawn } from "node:child_process";
import { getPidPath, getStateDir } from "./config.js";

// ---------------------------------------------------------------------------
// PID file helpers
// ---------------------------------------------------------------------------

function readPid(): number | null {
  const pidPath = getPidPath();
  try {
    const raw = fs.readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  fs.mkdirSync(getStateDir(), { recursive: true });
  fs.writeFileSync(getPidPath(), String(pid) + "\n");
}

function removePid(): void {
  const pidPath = getPidPath();
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // already gone
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
}

export interface StartAllOptions {
  reportMcpServers?: boolean;
}

export function getDaemonStatus(): DaemonStatus {
  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    return { running: true, pid };
  }
  // Stale PID file — clean up
  if (pid) removePid();
  return { running: false, pid: null };
}

/**
 * Start the daemon as a fully detached background process.
 * Returns the child PID, or null if already running.
 */
export function launchDaemon(): number | null {
  const status = getDaemonStatus();
  if (status.running) {
    return status.pid;
  }

  // Resolve the bikky binary — use the same node + cli entry that's running now
  const cliPath = new URL("./cli.js", import.meta.url).pathname;

  const child = spawn(process.execPath, [cliPath, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  child.unref();

  if (child.pid) {
    writePid(child.pid);
    return child.pid;
  }

  return null;
}

/**
 * Stop the daemon via PID file.
 * Returns true if a process was killed, false if nothing was running.
 */
export function killDaemon(): boolean {
  const pid = readPid();
  if (!pid) return false;

  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // race: died between check and kill
    }
  }

  removePid();
  return true;
}

/**
 * Full startup sequence: install MCP configs + launch daemon.
 */
export async function startAll(options: StartAllOptions = {}): Promise<void> {
  // 1. Write MCP configs
  const { writeInstallConfig } = await import("./install.js");
  await writeInstallConfig();

  // 2. Warn about already-running client-owned MCP server processes.
  if (options.reportMcpServers !== false) {
    const { reportRunningBikkyMcpServers } = await import("./mcp-processes.js");
    reportRunningBikkyMcpServers();
  }

  // 3. Launch daemon
  const status = getDaemonStatus();
  if (status.running) {
    console.log(`\n🟢 Daemon already running (PID ${status.pid})`);
  } else {
    const pid = launchDaemon();
    if (pid) {
      console.log(`\n🟢 Daemon started (PID ${pid})`);
    } else {
      console.error("\n🔴 Failed to start daemon");
    }
  }

  console.log("\n✨ bikky is ready — daemon running, MCP configs installed.");
  console.log("   GitHub Copilot CLI: run /restart. Claude Code: restart, then resume with claude --continue or claude -c.");
}
