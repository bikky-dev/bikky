import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR } from "../config.js";
import type { LogFn } from "./qdrant.js";

export const MAINTENANCE_STATE_PATH = join(STATE_DIR, "maintenance-state.json");

export type MaintenanceJobName = "relation_inference" | "entity_typing";

export interface MaintenanceRunSummary {
  job: MaintenanceJobName;
  ran_at: string;
  status: "success" | "skipped" | "error";
  candidates_seen: number;
  llm_calls: number;
  accepted: number;
  deterministic?: number;
  skipped_reason?: string;
  error?: string;
}

export interface MaintenanceJobState {
  last_run_at: string | null;
  cursor_updated_at: string | null;
  last_summary: MaintenanceRunSummary | null;
  recent_attempts: Record<string, string>;
}

export interface MaintenanceState {
  version: 1;
  jobs: Record<MaintenanceJobName, MaintenanceJobState>;
}

const defaultJobState = (): MaintenanceJobState => ({
  last_run_at: null,
  cursor_updated_at: null,
  last_summary: null,
  recent_attempts: {},
});

export const defaultMaintenanceState = (): MaintenanceState => ({
  version: 1,
  jobs: {
    relation_inference: defaultJobState(),
    entity_typing: defaultJobState(),
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const coerceJobState = (value: unknown): MaintenanceJobState => {
  if (!isRecord(value)) return defaultJobState();
  return {
    last_run_at: typeof value.last_run_at === "string" ? value.last_run_at : null,
    cursor_updated_at: typeof value.cursor_updated_at === "string" ? value.cursor_updated_at : null,
    last_summary: isRecord(value.last_summary) ? value.last_summary as unknown as MaintenanceRunSummary : null,
    recent_attempts: isRecord(value.recent_attempts)
      ? Object.fromEntries(
        Object.entries(value.recent_attempts)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
      : {},
  };
};

export const readMaintenanceState = (log: LogFn = () => {}): MaintenanceState => {
  if (!existsSync(MAINTENANCE_STATE_PATH)) return defaultMaintenanceState();
  try {
    const parsed = JSON.parse(readFileSync(MAINTENANCE_STATE_PATH, "utf-8")) as unknown;
    if (!isRecord(parsed)) return defaultMaintenanceState();
    const jobs = isRecord(parsed.jobs) ? parsed.jobs : {};
    return {
      version: 1,
      jobs: {
        relation_inference: coerceJobState(jobs.relation_inference),
        entity_typing: coerceJobState(jobs.entity_typing),
      },
    };
  } catch (e) {
    log("WARN", `Maintenance state: failed to read state, starting fresh: ${(e as Error).message}`);
    return defaultMaintenanceState();
  }
};

export const writeMaintenanceState = (state: MaintenanceState, log: LogFn = () => {}): void => {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(MAINTENANCE_STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } catch (e) {
    log("WARN", `Maintenance state: failed to write state: ${(e as Error).message}`);
  }
};

export const shouldRunMaintenance = (
  now: Date,
  lastRunAt: string | null,
  intervalSec: number,
): boolean => {
  if (intervalSec <= 0) return true;
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= intervalSec * 1000;
};

export const updateMaintenanceJob = (
  jobName: MaintenanceJobName,
  update: (job: MaintenanceJobState) => MaintenanceJobState,
  log: LogFn = () => {},
): MaintenanceState => {
  const state = readMaintenanceState(log);
  state.jobs[jobName] = update(state.jobs[jobName]);
  writeMaintenanceState(state, log);
  return state;
};

export const recordMaintenanceRun = (
  jobName: MaintenanceJobName,
  summary: MaintenanceRunSummary,
  options: {
    cursorUpdatedAt?: string | null;
    recentAttempts?: Record<string, string>;
  } = {},
  log: LogFn = () => {},
): MaintenanceState => updateMaintenanceJob(jobName, (job) => ({
  last_run_at: summary.ran_at,
  cursor_updated_at: options.cursorUpdatedAt === undefined ? job.cursor_updated_at : options.cursorUpdatedAt,
  last_summary: summary,
  recent_attempts: options.recentAttempts ?? job.recent_attempts,
}), log);

export const pruneRecentAttempts = (
  attempts: Record<string, string>,
  now: Date,
  maxAgeMs: number,
): Record<string, string> => Object.fromEntries(
  Object.entries(attempts).filter(([, attemptedAt]) => {
    const ts = Date.parse(attemptedAt);
    return Number.isFinite(ts) && now.getTime() - ts <= maxAgeMs;
  }),
);

export const isAttemptBackedOff = (
  attempts: Record<string, string>,
  key: string,
  now: Date,
  backoffMs: number,
): boolean => {
  const attemptedAt = attempts[key];
  if (!attemptedAt) return false;
  const ts = Date.parse(attemptedAt);
  return Number.isFinite(ts) && now.getTime() - ts < backoffMs;
};
