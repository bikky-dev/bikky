/**
 * Simple rotating file logger.
 * Writes to file only — stdout/stderr are reserved for MCP stdio transport.
 */

import fs from "node:fs";
import path from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogFn = (level: LogLevel, ...args: unknown[]) => void;

interface LoggerOpts {
  maxSize?: number;   // bytes before rotation (default 2MB)
  maxFiles?: number;  // rotated files to keep (default 3)
}

export function createLogger(
  name: string,
  filePath: string,
  opts: LoggerOpts = {},
): LogFn {
  const maxSize = opts.maxSize ?? 2 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 3;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let fd = fs.openSync(filePath, "a");
  let currentSize = 0;
  try { currentSize = fs.fstatSync(fd).size; } catch { /* new file */ }

  function rotate(): void {
    fs.closeSync(fd);
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const to = `${filePath}.${i}`;
      try { fs.renameSync(from, to); } catch { /* missing file is fine */ }
    }
    fd = fs.openSync(filePath, "w");
    currentSize = 0;
  }

  return (level: LogLevel, ...args: unknown[]): void => {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const msg = args.map((a) =>
      typeof a === "string" ? a : JSON.stringify(a),
    ).join(" ");
    const line = `[${ts}] [${name}] ${level}: ${msg}\n`;
    const buf = Buffer.from(line);
    fs.writeSync(fd, buf);
    currentSize += buf.length;
    if (currentSize > maxSize) rotate();
  };
}
