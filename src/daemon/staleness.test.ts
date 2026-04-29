/**
 * Tests for the staleness scanner.
 *
 * Uses dependency injection (StaleDeps) — no Qdrant or filesystem required.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { scanStaleFacts, setLogger, _resetDedup, type StaleDeps } from "./staleness.js";
import { CONFIG_DEFAULTS, type BikkyConfig } from "../config.js";
import type { QdrantScrollResult } from "./qdrant.js";

function makeConfig(overrides: Partial<BikkyConfig["daemon"]> = {}): BikkyConfig {
  return {
    ...CONFIG_DEFAULTS,
    daemon: { ...CONFIG_DEFAULTS.daemon, ...overrides },
  };
}

function makeFact(id: string, content = "x", category = "engineering"): QdrantScrollResult {
  return {
    id,
    content,
    category,
    domain: "software_engineering",
    kind: "fact",
    entities: [],
    last_reinforced_at: "2020-01-01T00:00:00.000Z",
    created_at: "2020-01-01T00:00:00.000Z",
  } as unknown as QdrantScrollResult;
}

describe("daemon/staleness", () => {
  let logs: Array<{ level: string; msg: string }>;

  beforeEach(() => {
    logs = [];
    setLogger(((level: string, ...args: unknown[]) => {
      logs.push({ level, msg: args.map(String).join(" ") });
    }) as unknown as Parameters<typeof setLogger>[0]);
    _resetDedup();
  });

  it("skips and logs DEBUG when Qdrant is not ready", async () => {
    let scrollCalls = 0;
    const deps: StaleDeps = {
      isReady: () => false,
      scrollFacts: async () => { scrollCalls++; return []; },
    };

    await scanStaleFacts(makeConfig(), deps);

    assert.equal(scrollCalls, 0);
    assert.ok(logs.some(l => l.level === "DEBUG" && /not ready/.test(l.msg)));
  });

  it("logs every stale fact and a summary line", async () => {
    const deps: StaleDeps = {
      isReady: () => true,
      scrollFacts: async () => [makeFact("a"), makeFact("b")],
    };

    await scanStaleFacts(makeConfig(), deps);

    const stale = logs.filter(l => /^Stale fact/.test(l.msg));
    assert.equal(stale.length, 2);
    assert.ok(logs.some(l => /found 2 stale fact/.test(l.msg)));
  });

  it("dedupes when the same set of stale facts appears twice", async () => {
    const deps: StaleDeps = {
      isReady: () => true,
      scrollFacts: async () => [makeFact("a"), makeFact("b")],
    };

    await scanStaleFacts(makeConfig(), deps);
    logs.length = 0;
    await scanStaleFacts(makeConfig(), deps);

    assert.equal(logs.filter(l => /^Stale fact/.test(l.msg)).length, 0);
    assert.ok(logs.some(l => /skipping duplicate log/.test(l.msg)));
  });

  it("re-logs when the set of stale facts changes", async () => {
    let call = 0;
    const deps: StaleDeps = {
      isReady: () => true,
      scrollFacts: async () => {
        call++;
        return call === 1 ? [makeFact("a")] : [makeFact("a"), makeFact("c")];
      },
    };

    await scanStaleFacts(makeConfig(), deps);
    logs.length = 0;
    await scanStaleFacts(makeConfig(), deps);

    assert.equal(logs.filter(l => /^Stale fact/.test(l.msg)).length, 2);
  });

  it("resets dedup state when no stale facts are found", async () => {
    let call = 0;
    const deps: StaleDeps = {
      isReady: () => true,
      scrollFacts: async () => {
        call++;
        if (call === 1) return [makeFact("a")];
        if (call === 2) return [];
        return [makeFact("a")];
      },
    };

    await scanStaleFacts(makeConfig(), deps);
    await scanStaleFacts(makeConfig(), deps);
    logs.length = 0;
    await scanStaleFacts(makeConfig(), deps);

    // Third call should re-log the same fact since dedup state was reset
    assert.ok(logs.some(l => /^Stale fact/.test(l.msg)));
  });

  it("swallows scroll errors with a WARN log", async () => {
    const deps: StaleDeps = {
      isReady: () => true,
      scrollFacts: async () => { throw new Error("network down"); },
    };

    await scanStaleFacts(makeConfig(), deps);

    assert.ok(logs.some(l => l.level === "WARN" && /network down/.test(l.msg)));
  });

  it("uses the configured staleness_threshold_days", async () => {
    let receivedFilters: { olderThan?: string } | undefined;
    const deps: StaleDeps = {
      isReady: () => true,
      scrollFacts: async (filters) => {
        receivedFilters = filters as { olderThan?: string };
        return [];
      },
    };

    await scanStaleFacts(makeConfig({ staleness_threshold_days: 7 }), deps);

    assert.ok(receivedFilters?.olderThan, "should pass an olderThan cutoff");
    const cutoff = new Date(receivedFilters!.olderThan!).getTime();
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // Cutoff should be ~7 days ago (allow 60s slop)
    assert.ok(Math.abs((now - cutoff) - sevenDaysMs) < 60_000);
  });
});
