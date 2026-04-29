/**
 * Staleness scanner — queries Qdrant for facts that haven't been verified
 * within the configured threshold and logs stale facts.
 *
 * Deduplication: tracks the last set of stale fact IDs.
 * If the same set is found again, skips to prevent log flooding.
 */

import * as qdrantMod from "./qdrant.js";
import type { BikkyConfig } from "../config.js";
import type { LogFn, QdrantScrollFilters, QdrantScrollResult } from "./qdrant.js";

let logFn: LogFn = console.log as unknown as LogFn;

/** Track the last stale fact IDs to avoid duplicate logging. */
let lastStaleIds: string = "";

/** Dependencies injectable for testing. */
export interface StaleDeps {
  isReady: () => boolean;
  scrollFacts: (filters?: QdrantScrollFilters, limit?: number) => Promise<QdrantScrollResult[]>;
}

const defaultDeps: StaleDeps = {
  isReady: qdrantMod.isReady,
  scrollFacts: qdrantMod.scrollFacts,
};

/**
 * Scan for stale facts via direct Qdrant scroll query.
 * Finds facts in configured categories whose last_reinforced_at is older than threshold.
 * Logs stale facts instead of writing to inbox.
 */
export const scanStaleFacts = async (config: BikkyConfig, deps: StaleDeps = defaultDeps): Promise<void> => {
  const threshold = config.daemon.staleness_threshold_days || 30;
  const categories = ["engineering", "product", "human", "system"];
  const limit = 3;

  if (!deps.isReady()) {
    logFn("DEBUG", "Staleness scan: Qdrant client not ready, skipping");
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - threshold);
  const cutoffISO = cutoff.toISOString();

  logFn("DEBUG", `Staleness scan: checking ${categories.join(",")} older than ${threshold} days`);

  try {
    const staleFacts = await deps.scrollFacts({
      categories,
      olderThan: cutoffISO,
    }, limit);

    if (staleFacts.length > 0) {
      // Deduplicate: only log if the set of stale fact IDs has changed
      const currentIds = staleFacts.map((f) => f.id).sort().join(",");
      if (currentIds === lastStaleIds) {
        logFn("DEBUG", `Staleness scan: same ${staleFacts.length} fact(s) still stale, skipping duplicate log`);
        return;
      }
      lastStaleIds = currentIds;

      for (const f of staleFacts) {
        logFn("INFO", `Stale fact [${f.category}] (${f.id}): "${f.content.slice(0, 80)}" — last reinforced: ${f.last_reinforced_at}`);
      }
      logFn("INFO", `Staleness scan: found ${staleFacts.length} stale fact(s)`);
    } else {
      lastStaleIds = "";
      logFn("DEBUG", "Staleness scan: no stale facts found");
    }
  } catch (e) {
    logFn("WARN", `Staleness scan failed: ${(e as Error).message}`);
  }
};

/** Reset dedup state (for testing). */
export const _resetDedup = (): void => { lastStaleIds = ""; };

export const setLogger = (log: LogFn): void => { logFn = log; };
