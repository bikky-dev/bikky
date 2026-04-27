import { useEffect, useState } from "react";
import { Link } from "react-router";

// Cache of entity name → type, populated lazily as chips render.
// Keyed by lowercase entity name. null = looked up but unknown.
const typeCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<void>>();

const TYPE_COLORS: Record<string, string> = {
  service: "bg-blue-900/40 text-blue-300 border-blue-800",
  repo: "bg-purple-900/40 text-purple-300 border-purple-800",
  file: "bg-emerald-900/40 text-emerald-300 border-emerald-800",
  person: "bg-amber-900/40 text-amber-300 border-amber-800",
  organization: "bg-rose-900/40 text-rose-300 border-rose-800",
  infrastructure: "bg-cyan-900/40 text-cyan-300 border-cyan-800",
  tool: "bg-indigo-900/40 text-indigo-300 border-indigo-800",
  concept: "bg-zinc-700/60 text-zinc-300 border-zinc-600",
  environment: "bg-orange-900/40 text-orange-300 border-orange-800",
  artifact: "bg-pink-900/40 text-pink-300 border-pink-800",
  unknown: "bg-zinc-800 text-zinc-500 border-zinc-700",
};

async function fetchTypes(names: string[]): Promise<void> {
  const missing = names.filter((n) => !typeCache.has(n) && !inflight.has(n));
  if (missing.length === 0) return;
  const key = missing.sort().join(",");
  const p = (async () => {
    try {
      const res = await fetch(`/api/memory/entity-types?names=${encodeURIComponent(missing.join(","))}`);
      if (!res.ok) return;
      const data = (await res.json()) as { types?: Record<string, string> };
      const types = data.types || {};
      for (const n of missing) {
        typeCache.set(n, types[n] ?? null);
      }
    } catch {
      for (const n of missing) typeCache.set(n, null);
    } finally {
      for (const n of missing) inflight.delete(n);
    }
  })();
  for (const n of missing) inflight.set(n, p);
  await p;
}

export interface EntityChipProps {
  name: string;
  link?: boolean;
}

export function EntityChip({ name, link = true }: EntityChipProps): JSX.Element {
  const lower = name.toLowerCase();
  const [type, setType] = useState<string | null>(typeCache.get(lower) ?? null);

  useEffect(() => {
    let cancelled = false;
    if (typeCache.has(lower)) {
      setType(typeCache.get(lower) ?? null);
      return;
    }
    fetchTypes([lower]).then(() => {
      if (!cancelled) setType(typeCache.get(lower) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [lower]);

  const colorClass = type ? TYPE_COLORS[type] ?? TYPE_COLORS.unknown : "bg-zinc-800 text-zinc-300 border-zinc-700";
  const label = type ? (
    <>
      {name}
      <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-70">{type}</span>
    </>
  ) : (
    name
  );
  const className = `inline-flex items-center px-2.5 py-1 rounded text-sm border ${colorClass} hover:brightness-125 transition`;

  if (!link) return <span className={className}>{label}</span>;
  return (
    <Link to={`/memory/entities/${encodeURIComponent(name)}`} className={className}>
      {label}
    </Link>
  );
}

// Convenience for callers that want to warm the cache for many entities at once.
export function preloadEntityTypes(names: string[]): void {
  const lowered = names.map((n) => n.toLowerCase()).filter(Boolean);
  if (lowered.length === 0) return;
  fetchTypes(lowered).catch(() => {});
}
