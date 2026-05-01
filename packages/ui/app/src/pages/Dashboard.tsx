import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../lib/api";
import { getStats, type MemoryStats } from "../lib/statsCache";
import { useDestination } from "../lib/useDestination";
import { CATEGORY_COLORS } from "../lib/format";
import { BROWSABLE_CATEGORY_OPTIONS, BROWSABLE_SUBTYPES_BY_CATEGORY, ontologyLabel } from "../lib/ontology";
import Badge from "../components/Badge";

type LoadState<T> = { loading: true } | { loading: false; data: T } | { loading: false; error: string };

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <p className="text-sm text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

function CategoryBar({ category, count, max }: { category: string; count: number; max: number }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  const color = CATEGORY_COLORS[category] ?? "zinc";
  const bgMap: Record<string, string> = {
    blue: "bg-blue-500",
    purple: "bg-purple-500",
    amber: "bg-amber-500",
    green: "bg-green-500",
    cyan: "bg-cyan-500",
    orange: "bg-orange-500",
    indigo: "bg-indigo-500",
    pink: "bg-pink-500",
    rose: "bg-rose-500",
    zinc: "bg-zinc-500",
  };
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-zinc-400 w-36 shrink-0">{ontologyLabel(category)}</span>
      <div className="flex-1 h-5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${bgMap[color] ?? "bg-zinc-500"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-zinc-400 w-10 text-right">{count}</span>
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<LoadState<MemoryStats>>({ loading: true });
  const destination = useDestination();

  useEffect(() => {
    setStats({ loading: true });
    getStats()
      .then((data) => setStats({ loading: false, data }))
      .catch((e) => {
        const code = e instanceof ApiError ? e.code : undefined;
        const msg = e instanceof Error ? e.message : "unknown";
        setStats({ loading: false, error: code === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : msg });
      });
  }, [destination]);

  if (stats.loading) {
    return (
      <div>
        <h2 className="text-2xl font-bold mb-6">Memory Dashboard</h2>
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  if ("error" in stats) {
    const isNotConfigured = stats.error.includes("NOT_CONFIGURED") || stats.error.includes("not configured");
    return (
      <div>
        <h2 className="text-2xl font-bold mb-6">Memory Dashboard</h2>
        {isNotConfigured ? (
          <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 p-6">
            <h3 className="text-lg font-semibold text-amber-200 mb-2">🔧 Setup Required</h3>
            <p className="text-sm text-amber-300/80 mb-4">
              Qdrant is not configured. bikky needs a vector database to store memories.
            </p>
            <div className="rounded-md bg-zinc-900 p-4 text-sm text-zinc-300 font-mono">
              <p className="text-zinc-500 mb-1"># Run in your terminal:</p>
              <p>bikky setup</p>
            </div>
            <p className="text-xs text-zinc-500 mt-3">
              This will walk you through connecting to Qdrant Cloud (free tier) and configuring your embedding provider.
            </p>
          </div>
        ) : (
          <p className="text-red-400">Failed to load memory stats: {stats.error}</p>
        )}
      </div>
    );
  }

  const { active, superseded, total, byCategory, byKind, bySubtype } = stats.data;
  const categoryCounts = BROWSABLE_CATEGORY_OPTIONS.map((category) => [category.value, byCategory[category.value] ?? 0] as const);
  const browsableSubtypes = BROWSABLE_CATEGORY_OPTIONS.flatMap((category) => BROWSABLE_SUBTYPES_BY_CATEGORY[category.value] ?? []);
  const maxCat = Math.max(...categoryCounts.map(([, count]) => count), 1);
  const subtypeTotal = browsableSubtypes.reduce((sum, subtype) => sum + (bySubtype?.[subtype.value] ?? 0), 0);
  const activeSubtypeCount = browsableSubtypes.filter((subtype) => (bySubtype?.[subtype.value] ?? 0) > 0).length;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Memory Dashboard</h2>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Active Facts" value={active} />
        <StatCard label="Total Stored" value={total} sub={`${superseded} superseded`} />
        <StatCard label="Categories" value={BROWSABLE_CATEGORY_OPTIONS.length} />
        <StatCard label="Subtypes" value={activeSubtypeCount} sub={`${subtypeTotal.toLocaleString()} typed memories`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Category breakdown */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h3 className="text-sm font-medium text-zinc-400 mb-4">Facts by Category</h3>
          <div className="space-y-2.5">
            {categoryCounts
              .sort(([, a], [, b]) => b - a)
              .map(([cat, count]) => (
                <Link key={cat} to={`/memory?category=${cat}`} className="block hover:opacity-80 transition-opacity">
                  <CategoryBar category={cat} count={count} max={maxCat} />
                </Link>
              ))}
          </div>
        </div>

        {/* Kind breakdown */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h3 className="text-sm font-medium text-zinc-400 mb-4">Facts by Kind</h3>
          <div className="space-y-3">
            {Object.entries(byKind)
              .sort(([, a], [, b]) => b - a)
              .map(([kind, count]) => (
                <div
                  key={kind}
                  className="flex items-center justify-between px-3 py-2 rounded-md bg-zinc-950/40"
                >
                  <Badge label={ontologyLabel(kind)} color={kind === "fact" ? "blue" : kind === "summary" ? "purple" : kind === "distilled" ? "amber" : kind === "telemetry" ? "red" : "cyan"} />
                  <span className="text-sm text-zinc-300">{count}</span>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Subtype navigation */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5 mb-8">
        <div className="mb-4">
          <h3 className="text-sm font-medium text-zinc-300">Browse by category and subtype</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Categories are the user-facing ontology areas. Subtypes are the concrete memory shapes inside each category.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {BROWSABLE_CATEGORY_OPTIONS.map((category) => (
            <div key={category.value} className="rounded-md border border-zinc-800 bg-zinc-950/50 p-3">
              <Link
                to={`/memory?category=${category.value}`}
                className="text-sm font-medium text-zinc-200 hover:text-white"
              >
                {category.label}
              </Link>
              <p className="mt-1 text-xs text-zinc-500">{category.description}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(BROWSABLE_SUBTYPES_BY_CATEGORY[category.value] ?? []).map((subtype) => {
                  const count = bySubtype?.[subtype.value] ?? 0;
                  return (
                    <Link
                      key={subtype.value}
                      to={`/memory?memory_subtype=${encodeURIComponent(subtype.value)}`}
                      title={subtype.description}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
                    >
                      <span>{subtype.label}</span>
                      <span className="text-zinc-500">{count.toLocaleString()}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex gap-3">
        <Link
          to="/memory"
          className="px-4 py-2 rounded-md bg-zinc-800 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
        >
          Browse All Facts →
        </Link>
        <Link
          to="/graph"
          className="px-4 py-2 rounded-md bg-zinc-800 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
        >
          View Graph →
        </Link>
      </div>
    </div>
  );
}
