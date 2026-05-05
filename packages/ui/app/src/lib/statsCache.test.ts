import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDestinationOptions, setSelectedDestination } from "./destinationStore";
import { clearStatsCache, getStats, type MemoryStats } from "./statsCache";

const stats: MemoryStats = {
  total: 3,
  active: 2,
  superseded: 1,
  byCategory: { engineering: 2 },
  byKind: { fact: 2 },
  bySubtype: {},
};

describe("statsCache", () => {
  const requests: string[] = [];

  beforeEach(() => {
    requests.length = 0;
    clearStatsCache();
    setDestinationOptions([
      { name: "perso", collection: "perso_collection", isDefault: true },
      { name: "work", collection: "work_collection", isDefault: false },
    ]);
    setSelectedDestination("all");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify(stats), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearStatsCache();
  });

  it("deduplicates simultaneous stats requests by destination and filters", async () => {
    const [first, second] = await Promise.all([
      getStats({ kind: "fact" }),
      getStats({ kind: "fact" }),
    ]);

    expect(first).toEqual(stats);
    expect(second).toEqual(stats);
    expect(requests).toEqual(["/api/memory/stats?kind=fact&destination=all"]);

    await getStats({ kind: "fact" });
    expect(requests).toHaveLength(1);
  });

  it("clears cached stats when the selected destination changes", async () => {
    await getStats({ source: "agent" });
    setSelectedDestination("work");
    await getStats({ source: "agent" });

    expect(requests).toEqual([
      "/api/memory/stats?source=agent&destination=all",
      "/api/memory/stats?source=agent&destination=work",
    ]);
  });

  it("refreshes stats by bypassing matching cache and inflight entries", async () => {
    await getStats({ kind: "fact" });
    await getStats({ kind: "fact" }, true);

    expect(requests).toEqual([
      "/api/memory/stats?kind=fact&destination=all",
      "/api/memory/stats?kind=fact&refresh=true&destination=all",
    ]);
  });
});

