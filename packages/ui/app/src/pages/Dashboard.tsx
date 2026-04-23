import { useEffect, useState } from "react";
import { Link } from "react-router";
import { apiFetch } from "../lib/api";
import { CATEGORY_COLORS } from "../lib/format";
import Badge from "../components/Badge";

interface MemoryStats {
  total: number;
  active: number;
  superseded: number;
  byCategory: Record<string, number>;
  byKind: Record<string, number>;
}

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
    rose: "bg-rose-500",
    zinc: "bg-zinc-500",
  };
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-zinc-400 w-28 shrink-0 capitalize">{category}</span>
      <div className="flex-1 h-5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${bgMap[color] ?? "bg-zinc-500"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-zinc-400 w-10 text-right">{count}</span>
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<LoadState<MemoryStats>>({ loading: true });

  useEffect(() => {
    apiFetch<MemoryStats>("/api/memory/stats")
      .then((data) => setStats({ loading: false, data }))
      .catch((e) => setStats({ loading: false, error: e instanceof Error ? e.message : "unknown" }));
  }, []);

  if (stats.loading) {
    return (
      <div>
        <h2 className="text-2xl font-bold mb-6">Memory Dashboard</h2>
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  if ("error" in stats) {
    return (
      <div>
        <h2 className="text-2xl font-bold mb-6">Memory Dashboard</h2>
        <p className="text-red-400">Failed to load memory stats: {stats.error}</p>
      </div>
    );
  }

  const { active, superseded, total, byCategory, byKind } = stats.data;
  const maxCat = Math.max(...Object.values(byCategory), 1);

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Memory Dashboard</h2>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Active Facts" value={active} />
        <StatCard label="Total Stored" value={total} sub={`${superseded} superseded`} />
        <StatCard label="Categories" value={Object.keys(byCategory).length} />
        <StatCard label="Kinds" value={Object.keys(byKind).length} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Category breakdown */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h3 className="text-sm font-medium text-zinc-400 mb-4">Facts by Category</h3>
          <div className="space-y-2.5">
            {Object.entries(byCategory)
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
                <Link
                  key={kind}
                  to={`/memory?kind=${kind}`}
                  className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-zinc-800 transition-colors"
                >
                  <Badge label={kind} color={kind === "fact" ? "blue" : kind === "summary" ? "purple" : kind === "distilled" ? "amber" : "cyan"} />
                  <span className="text-sm text-zinc-300">{count}</span>
                </Link>
              ))}
          </div>
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
          to="/memory?kind=relation"
          className="px-4 py-2 rounded-md bg-zinc-800 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
        >
          View Relations →
        </Link>
      </div>
    </div>
  );
}
