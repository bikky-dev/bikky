/**
 * Lightweight LLM telemetry — appends one JSON line per call to
 * ~/.bikky/logs/llm.jsonl (or BIKKY_LLM_LOG override). Rotates at
 * BIKKY_LLM_LOG_MAX_BYTES (default 10 MB).
 *
 * Telemetry is best-effort: any failure is swallowed and logged to the
 * provided logger.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import type { LogFn } from "./types.js";

const DEFAULT_PATH = path.join(os.homedir(), ".bikky", "logs", "llm.jsonl");
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface LLMTelemetryRecord {
  ts: string;
  prompt: string;
  model: string;
  provider: "ollama" | "openai" | "bedrock";
  ok: boolean;
  latency_ms: number;
  tokens_in_est: number;
  tokens_out_est: number;
  error?: string;
  request_id?: string;
}

const logPath = (): string => process.env.BIKKY_LLM_LOG ?? DEFAULT_PATH;
const maxBytes = (): number => {
  const v = process.env.BIKKY_LLM_LOG_MAX_BYTES;
  return v ? Number.parseInt(v, 10) || DEFAULT_MAX_BYTES : DEFAULT_MAX_BYTES;
};

/** Crude token estimator: ~4 chars per token. Good enough for trend lines. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

let warned = false;
export async function writeTelemetry(record: LLMTelemetryRecord, log: LogFn): Promise<void> {
  const file = logPath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (existsSync(file)) {
      const stat = await fs.stat(file);
      if (stat.size > maxBytes()) {
        const rotated = `${file}.1`;
        await fs.rename(file, rotated).catch(() => {});
      }
    }
    await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    if (!warned) {
      warned = true;
      log("WARN", `LLM telemetry disabled: ${(e as Error).message}`);
    }
  }
}
