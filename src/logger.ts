/**
 * Structured logger backed by pino.
 *
 * Output is JSON-lines written to a rotating log file. We do NOT log to
 * stdout/stderr because the MCP server reserves stdio for its transport.
 *
 * The exported `LogFn` signature is preserved for backward compatibility:
 * callers continue to invoke `log("INFO", "msg", ...args)` and pino emits
 * a structured record `{level, time, name, msg, ...extra}`. New code can
 * pass a plain object as the first arg to attach structured fields:
 *
 *   log("INFO", { event: "embed_request", provider: "openai" }, "ok");
 *
 * We rotate the file in-process (no worker threads) by checking size after
 * each write and recreating the pino destination when the threshold is
 * exceeded.
 */

import fs from "node:fs";
import path from "node:path";
import pino from "pino";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogFn = (level: LogLevel | string, ...args: unknown[]) => void;

interface LoggerOpts {
  /** Bytes before rotation (default 2MB). */
  maxSize?: number;
  /** Rotated files to keep (default 3). */
  maxFiles?: number;
}

const LEVEL_MAP: Record<string, "debug" | "info" | "warn" | "error"> = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

function buildPino(name: string, filePath: string): pino.Logger {
  const dest = pino.destination({ dest: filePath, sync: true, append: true, mkdir: true });
  return pino(
    {
      name,
      level: "debug",
      // Omit pid / hostname — every line carries `name` instead.
      base: { name },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        // Emit human-readable level strings ("info") rather than numeric codes.
        level(label) {
          return { level: label };
        },
      },
    },
    dest,
  );
}

function safeSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function createLogger(
  name: string,
  filePath: string,
  opts: LoggerOpts = {},
): LogFn {
  const maxSize = opts.maxSize ?? 2 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 3;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let logger = buildPino(name, filePath);
  let writtenSinceCheck = 0;

  function rotate(): void {
    try {
      logger.flush();
    } catch {
      /* ignore — pino sync mode flushes on every write */
    }
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const to = `${filePath}.${i}`;
      try {
        fs.renameSync(from, to);
      } catch {
        /* missing file is fine */
      }
    }
    logger = buildPino(name, filePath);
    writtenSinceCheck = 0;
  }

  function maybeRotate(): void {
    // Cheap heuristic: only stat the file once we've written enough bytes
    // to plausibly cross the threshold. Avoids a stat on every log line.
    if (writtenSinceCheck < 4096) return;
    writtenSinceCheck = 0;
    if (safeSize(filePath) > maxSize) rotate();
  }

  return (level: LogLevel | string, ...args: unknown[]): void => {
    const lvl = LEVEL_MAP[level] ?? "info";
    const fn = logger[lvl].bind(logger);

    let approxBytes = 0;
    const first = args[0];
    if (
      first !== null &&
      typeof first === "object" &&
      !Array.isArray(first) &&
      !(first instanceof Error)
    ) {
      // Structured form: log("INFO", {fields}, "msg", ...)
      const rest = args.slice(1);
      const msg = rest
        .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
        .join(" ");
      fn(first as Record<string, unknown>, msg);
      try {
        approxBytes = JSON.stringify(first).length + msg.length;
      } catch {
        approxBytes = msg.length;
      }
    } else {
      const msg = args
        .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
        .join(" ");
      fn(msg);
      approxBytes = msg.length;
    }

    writtenSinceCheck += approxBytes + 80; // +80 for JSON envelope (level/time/name/...)
    maybeRotate();
  };
}
