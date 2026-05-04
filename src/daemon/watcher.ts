/**
 * Session watcher helpers for supported coding-agent transcript directories.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";

export interface WatchedSession {
  uuid: string;
  eventsPath: string;
  active: boolean;
  source?: "copilot" | "claude";
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
      source: "copilot",
    });
  }
  return sessions;
}

export function discoverClaudeSessions(): WatchedSession[] {
  const cfg = loadConfig();
  if (!cfg.watchers.claude.enabled) return [];

  const baseDir = cfg.watchers.claude.path;
  if (!fs.existsSync(baseDir)) return [];

  const sessions: WatchedSession[] = [];
  for (const entry of fs.readdirSync(baseDir)) {
    const projectPath = path.join(baseDir, entry);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(projectPath);
    } catch {
      continue;
    }

    if (stat.isFile() && entry.endsWith(".jsonl")) {
      sessions.push({
        uuid: path.basename(entry, ".jsonl"),
        eventsPath: projectPath,
        active: true,
        source: "claude",
      });
      continue;
    }

    if (!stat.isDirectory()) continue;

    for (const file of fs.readdirSync(projectPath)) {
      const transcriptPath = path.join(projectPath, file);
      let transcriptStat: fs.Stats;
      try {
        transcriptStat = fs.statSync(transcriptPath);
      } catch {
        continue;
      }
      if (!transcriptStat.isFile() || !file.endsWith(".jsonl")) continue;

      sessions.push({
        uuid: path.basename(file, ".jsonl"),
        eventsPath: transcriptPath,
        active: true,
        source: "claude",
      });
    }
  }

  return sessions;
}
