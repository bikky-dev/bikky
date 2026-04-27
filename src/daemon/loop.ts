/**
 * Daemon tick loop — orchestrates extraction, consolidation, relations, staleness.
 */
import path from "node:path";
import { loadConfig, LOG_DIR } from "../config.js";
import { createLogger } from "../logger.js";
import { initLLM } from "../llm/index.js";
import type { LogFn } from "./qdrant.js";

// Import daemon modules
import * as qdrantClient from "./qdrant.js";
import { tick as extractionTick, setLogger as setExtractionLogger } from "./extraction.js";
import { tick as consolidationTick, setLogger as setConsolidationLogger } from "./consolidation.js";
import { tick as relationsTick, setLogger as setRelationsLogger } from "./relations.js";
import { tick as entityTypingTick, setLogger as setEntityTypingLogger } from "./entity-typing.js";
import { scanStaleFacts, setLogger as setStalenessLogger } from "./staleness.js";
import { inspectWatcherPaths, formatIssue } from "./watcher-health.js";

// createLogger returns (LogLevel, ...args) but daemon modules accept (string, ...args).
// The daemon only calls with valid LogLevel values, so the cast is safe.
const log = createLogger("daemon", path.join(LOG_DIR, "daemon.log")) as unknown as LogFn;

let running = false;
let tickCount = 0;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

export async function startDaemon(): Promise<void> {
  const cfg = loadConfig();
  log("INFO", `Starting bikky daemon (PID ${process.pid})`);

  // Sanity-check watcher paths — warn loudly if any look broken so users
  // don't end up with a silently-idle daemon (issue #58).
  for (const issue of inspectWatcherPaths(cfg)) {
    log("WARN", formatIssue(issue));
  }

  // Wire up loggers for all daemon sub-modules
  qdrantClient.setLogger(log);
  setExtractionLogger(log);
  setConsolidationLogger(log);
  setRelationsLogger(log);
  setEntityTypingLogger(log);
  setStalenessLogger(log);

  // Initialize LLM client from config
  initLLM({
    config: {
      provider: cfg.llm.provider,
      model: cfg.llm.model,
      baseUrl: cfg.llm.base_url,
      apiKey: cfg.llm.api_key,
      fallback: cfg.llm.fallback_provider ?? null,
      extra: cfg.llm.extra ?? {},
      timeoutMs: cfg.llm.timeout_ms,
      retries: cfg.llm.retries,
      retryBaseDelayMs: cfg.llm.retry_base_delay_ms,
    },
    logger: log as unknown as import("../llm/index.js").LogFn,
  });

  // Initialize Qdrant client
  const ready = qdrantClient.init();
  if (!ready) {
    log("WARN", "Qdrant not configured — daemon will retry on each tick");
  } else {
    try {
      await qdrantClient.ensureCollection();
    } catch (e) {
      log("WARN", `Qdrant collection/index readiness check failed: ${(e as Error).message}`);
    }
  }

  running = true;
  const intervalMs = (cfg.daemon.tick_interval_sec || 5) * 1000;

  const tickFn = async (): Promise<void> => {
    if (!running) return;
    tickCount++;

    try {
      await extractionTick(cfg);
    } catch (e) {
      log("ERROR", `Extraction tick failed: ${(e as Error).message}`);
    }

    // Consolidation runs less frequently (handled internally via tick counts)
    try {
      await consolidationTick(cfg);
    } catch (e) {
      log("ERROR", `Consolidation tick failed: ${(e as Error).message}`);
    }

    try {
      await relationsTick(cfg);
    } catch (e) {
      log("ERROR", `Relations tick failed: ${(e as Error).message}`);
    }

    try {
      await entityTypingTick();
    } catch (e) {
      log("ERROR", `Entity typing tick failed: ${(e as Error).message}`);
    }

    // Staleness scans every 1000 ticks (~83 min at 5s interval)
    if (tickCount % 1000 === 0) {
      try {
        await scanStaleFacts(cfg);
      } catch (e) {
        log("ERROR", `Staleness scan failed: ${(e as Error).message}`);
      }
    }
  };

  intervalHandle = setInterval(() => { tickFn().catch(e => log("ERROR", `Tick loop error: ${(e as Error).message}`)); }, intervalMs);
  log("INFO", `Daemon running — tick interval ${intervalMs}ms`);
}

export function stopDaemon(): void {
  running = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  log("INFO", "Daemon stopping");
}
