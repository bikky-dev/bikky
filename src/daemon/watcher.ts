/**
 * Copilot session watcher — detects active sessions by scanning
 * ~/.copilot/session-state/ for directories with events.jsonl files.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";

export interface WatchedSession {
  uuid: string;
  eventsPath: string;
  active: boolean;  // has inuse.*.lock file
}

export function discoverSessions(): WatchedSession[] {
  const cfg = loadConfig();
  const baseDir = cfg.watchers.copilot.path;
  if (!fs.existsSync(baseDir)) return [];

  const sessions: WatchedSession[] = [];
  for (const entry of fs.readdirSync(baseDir)) {
    const sessionDir = path.join(baseDir, entry);
    const eventsPath = path.join(sessionDir, "events.jsonl");

    let isDir = false;
    try {
      isDir = fs.statSync(sessionDir).isDirectory();
    } catch { continue; }
    if (!isDir) continue;

    if (!fs.existsSync(eventsPath)) continue;

    // Check for active lock files
    const lockFiles = fs.readdirSync(sessionDir).filter(
      (f) => f.startsWith("inuse.") && f.endsWith(".lock"),
    );

    sessions.push({
      uuid: entry,
      eventsPath,
      active: lockFiles.length > 0,
    });
  }
  return sessions;
}
