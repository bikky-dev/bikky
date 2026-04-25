import { apiFetch } from "./api";

export interface MemoryStats {
  total: number;
  active: number;
  superseded: number;
  byCategory: Record<string, number>;
  byKind: Record<string, number>;
}

const TTL_MS = 30_000;

let cached: { data: MemoryStats; expiresAt: number } | null = null;
let inflight: Promise<MemoryStats> | null = null;

/**
 * Module-level dedup + TTL cache for /api/memory/stats so the Dashboard and
 * Memory pages don't double-fetch the (expensive) stats fan-out on simultaneous
 * mount. Use refresh=true to bust both caches.
 */
export async function getStats(refresh = false): Promise<MemoryStats> {
  if (refresh) {
    cached = null;
    inflight = null;
  }
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (inflight) return inflight;

  inflight = apiFetch<MemoryStats>(`/api/memory/stats${refresh ? "?refresh=true" : ""}`)
    .then((data) => {
      cached = { data, expiresAt: Date.now() + TTL_MS };
      return data;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function clearStatsCache(): void {
  cached = null;
  inflight = null;
}
