import { apiFetch } from "./api";
import { getSelectedDestination, subscribeDestination } from "./destinationStore";

export interface MemoryStats {
  total: number;
  active: number;
  superseded: number;
  byCategory: Record<string, number>;
  byKind: Record<string, number>;
  bySubtype: Record<string, number>;
  quality: {
    rollupCount: number;
    activeFactCount: number;
    recallCount: number;
    usefulCount: number;
    misleadingCount: number;
    wrongCount: number;
    staleCount: number;
    lowConfidenceCount: number;
    usefulPercent: number | null;
    stalePercent: number | null;
    lowConfidencePercent: number | null;
    needsReviewCount: number;
    needsReviewPercent: number | null;
    latestGeneratedAt: string | null;
  };
}

export interface MemoryStatsFilters {
  kind?: string;
  source?: string;
}

const TTL_MS = 30_000;

const cached = new Map<string, { data: MemoryStats; expiresAt: number }>();
const inflight = new Map<string, Promise<MemoryStats>>();

// Drop cached/inflight entries when the user switches destinations so we don't
// serve stats from the previous destination scope.
subscribeDestination(() => {
  cached.clear();
  inflight.clear();
});

function normalizeArgs(filtersOrRefresh: MemoryStatsFilters | boolean, refresh: boolean) {
  if (typeof filtersOrRefresh === "boolean") {
    return { filters: {}, refresh: filtersOrRefresh };
  }
  return { filters: filtersOrRefresh, refresh };
}

function statsQuery(filters: MemoryStatsFilters, refresh: boolean): { key: string; query: string } {
  const params = new URLSearchParams();
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.source) params.set("source", filters.source);
  if (refresh) params.set("refresh", "true");
  const dest = getSelectedDestination() ?? "";
  const key = `dest=${dest}&kind=${filters.kind ?? ""}&source=${filters.source ?? ""}`;
  const query = params.toString();
  return { key, query: query ? `?${query}` : "" };
}

/**
 * Module-level dedup + TTL cache for /api/memory/stats so the Dashboard and
 * Memory pages don't double-fetch the (expensive) stats fan-out on simultaneous
 * mount. Counts can be scoped to source/kind for the Memory advanced filters.
 */
export async function getStats(filtersOrRefresh: MemoryStatsFilters | boolean = {}, refresh = false): Promise<MemoryStats> {
  const args = normalizeArgs(filtersOrRefresh, refresh);
  const { key, query } = statsQuery(args.filters, args.refresh);
  if (args.refresh) {
    cached.delete(key);
    inflight.delete(key);
  }
  const cachedStats = cached.get(key);
  if (cachedStats && cachedStats.expiresAt > Date.now()) return cachedStats.data;
  const inflightStats = inflight.get(key);
  if (inflightStats) return inflightStats;

  const request = apiFetch<MemoryStats>(`/api/memory/stats${query}`)
    .then((data) => {
      cached.set(key, { data, expiresAt: Date.now() + TTL_MS });
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}

export function clearStatsCache(): void {
  cached.clear();
  inflight.clear();
}
