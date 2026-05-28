/**
 * Shared paused-sessions file management.
 *
 * Both the MCP server (memory_pause/resume tools) and the daemon (extraction tick)
 * use this module. The MCP server writes pause/resume state; the daemon reads it
 * to skip extraction for paused sessions.
 *
 * File: ~/.bikky/state/paused-sessions.json
 * Format: { "uuid:<UUID>": { reason, paused_at }, ... }
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "./config.js";

export interface PausedSessionEntry {
  reason: string;
  paused_at: string; // ISO timestamp
}

export type PausedSessionsFile = Record<string, PausedSessionEntry>;

const FILENAME = "paused-sessions.json";

const filePath = (): string => join(getStateDir(), FILENAME);

export const readPausedSessions = (): PausedSessionsFile => {
  try {
    const raw = readFileSync(filePath(), "utf-8");
    return JSON.parse(raw) as PausedSessionsFile;
  } catch {
    return {};
  }
};

export const writePausedSessions = (data: PausedSessionsFile): void => {
  const dir = getStateDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath(), JSON.stringify(data, null, 2), "utf-8");
};

/**
 * Add a session to the paused list. The key should match the daemon's
 * extractionStateKey format: "uuid:<UUID>" for copilot, "claude:<UUID>" for claude.
 */
export const pauseSession = (sessionKey: string, reason: string): void => {
  const data = readPausedSessions();
  data[sessionKey] = { reason, paused_at: new Date().toISOString() };
  writePausedSessions(data);
};

/**
 * Remove a session from the paused list.
 */
export const resumeSession = (sessionKey: string): boolean => {
  const data = readPausedSessions();
  if (!(sessionKey in data)) return false;
  delete data[sessionKey];
  writePausedSessions(data);
  return true;
};

/**
 * Check if a session key is currently paused.
 */
export const isSessionPaused = (sessionKey: string): boolean => {
  const data = readPausedSessions();
  return sessionKey in data;
};
