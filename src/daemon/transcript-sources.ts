import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";

import type { BikkyConfig } from "../config.js";

export type TranscriptSource = "copilot" | "claude";

export interface TranscriptMapping {
  source: TranscriptSource;
  uuid: string;
  eventsPath: string;
  active: boolean;
  pid?: number;
}

export interface ParsedEvent {
  type: string;
  content: string;
  timestamp: string;
}

const COPILOT_EXTRACTABLE_TYPES = new Set([
  "user.message",
  "assistant.message",
  "session.compaction_complete",
]);

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const readDirIfExists = async (dir: string): Promise<Dirent[]> => {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (isNotFoundError(e)) return [];
    throw e;
  }
};

export const extractionStateKey = (mapping: Pick<TranscriptMapping, "source" | "uuid">): string =>
  mapping.source === "copilot" ? `uuid:${mapping.uuid}` : `claude:${mapping.uuid}`;

export const transcriptLabel = (mapping: Pick<TranscriptMapping, "source" | "uuid">): string =>
  `${mapping.source}:${mapping.uuid.slice(0, 8)}`;

export const discoverCopilotTranscriptMappings = async (
  config: BikkyConfig,
  isProcessAlive: (pid: number) => boolean,
): Promise<TranscriptMapping[]> => {
  if (!config.watchers.copilot.enabled) return [];

  const copilotStateDir = config.watchers.copilot.path;
  const mappings: TranscriptMapping[] = [];

  const sessionDirs = await readDirIfExists(copilotStateDir);
  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory()) continue;

    const uuid = sessionDir.name;
    const sessionPath = join(copilotStateDir, uuid);
    const entries = await readDirIfExists(sessionPath);

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const pidMatch = entry.name.match(/^inuse\.(\d+)\.lock$/);
      if (!pidMatch || !uuid) continue;

      const pid = parseInt(pidMatch[1]!, 10);
      if (!isProcessAlive(pid)) continue;

      const eventsPath = join(copilotStateDir, uuid, "events.jsonl");
      try {
        await stat(eventsPath);
      } catch (e) {
        if (isNotFoundError(e)) continue;
        throw e;
      }
      mappings.push({ source: "copilot", pid, uuid, eventsPath, active: true });
    }
  }

  return mappings;
};

export const discoverClaudeTranscriptMappings = async (config: BikkyConfig): Promise<TranscriptMapping[]> => {
  if (!config.watchers.claude.enabled) return [];

  const baseDir = config.watchers.claude.path;
  const mappings: Array<TranscriptMapping & { mtimeMs: number }> = [];
  const entries = await readDirIfExists(baseDir);

  for (const entry of entries) {
    const entryPath = join(baseDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const fileStat = await stat(entryPath);
      mappings.push({
        source: "claude",
        uuid: basename(entry.name, ".jsonl"),
        eventsPath: entryPath,
        active: true,
        mtimeMs: fileStat.mtimeMs,
      });
      continue;
    }

    if (!entry.isDirectory()) continue;

    const projectEntries = await readDirIfExists(entryPath);
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isFile() || !projectEntry.name.endsWith(".jsonl")) continue;
      const eventsPath = join(entryPath, projectEntry.name);
      const fileStat = await stat(eventsPath);
      mappings.push({
        source: "claude",
        uuid: basename(projectEntry.name, ".jsonl"),
        eventsPath,
        active: true,
        mtimeMs: fileStat.mtimeMs,
      });
    }
  }

  return mappings
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ mtimeMs: _mtimeMs, ...mapping }) => mapping);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (value: unknown): string =>
  typeof value === "string" ? value : "";

const claudeTextContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isRecord(block) || block.type !== "text") continue;
    const text = stringField(block.text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
};

export const parseCopilotTranscriptLine = (line: string): ParsedEvent | null => {
  const obj = JSON.parse(line) as {
    type?: string;
    timestamp?: string;
    data?: Record<string, unknown>;
  };

  if (!obj.type || !COPILOT_EXTRACTABLE_TYPES.has(obj.type)) return null;

  const data = obj.data || {};
  let content = "";

  if (obj.type === "user.message") {
    content = stringField(data.content);
  } else if (obj.type === "assistant.message") {
    const parts: string[] = [];
    const contentText = stringField(data.content);
    const reasoningText = stringField(data.reasoningText);
    if (contentText) parts.push(contentText);
    if (reasoningText) parts.push(reasoningText);
    content = parts.join("\n");
  } else if (obj.type === "session.compaction_complete") {
    content = stringField(data.summaryContent);
  }

  if (!content) return null;
  return {
    type: obj.type,
    content,
    timestamp: obj.timestamp || new Date().toISOString(),
  };
};

export const parseClaudeTranscriptLine = (line: string): ParsedEvent | null => {
  const obj = JSON.parse(line) as Record<string, unknown>;
  const recordType = obj.type;
  if (recordType !== "user" && recordType !== "assistant") return null;

  const message = isRecord(obj.message) ? obj.message : null;
  if (!message) return null;

  const role = message.role === "user" || message.role === "assistant" ? message.role : recordType;
  if (role !== "user" && role !== "assistant") return null;

  const content = claudeTextContent(message.content).trim();
  if (!content) return null;

  return {
    type: role === "user" ? "user.message" : "assistant.message",
    content,
    timestamp: stringField(obj.timestamp) || new Date().toISOString(),
  };
};

export const readNewTranscriptEvents = async (
  eventsPath: string,
  byteOffset: number,
  source: TranscriptSource,
): Promise<{ events: ParsedEvent[]; newOffset: number; totalLines: number }> => {
  const fileStat = await stat(eventsPath);
  if (fileStat.size === byteOffset) {
    return { events: [], newOffset: byteOffset, totalLines: 0 };
  }
  const startOffset = fileStat.size < byteOffset ? 0 : byteOffset;

  const buf = await readFile(eventsPath);
  const newContent = buf.subarray(startOffset).toString("utf-8");
  const events: ParsedEvent[] = [];
  let totalLines = 0;

  for (const line of newContent.split("\n")) {
    if (!line.trim()) continue;
    totalLines++;

    try {
      const event = source === "claude"
        ? parseClaudeTranscriptLine(line)
        : parseCopilotTranscriptLine(line);
      if (event) events.push(event);
    } catch {
      // Malformed line — skip it.
    }
  }

  return { events, newOffset: fileStat.size, totalLines };
};
