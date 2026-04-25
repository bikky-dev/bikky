import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Search, Loader2, Database, ArrowUpDown } from "lucide-react";
import { apiFetch } from "../lib/api";
import { getStats, type MemoryStats as Stats } from "../lib/statsCache";
import FactCard, { type Fact } from "../components/FactCard";

const CATEGORIES = ["infrastructure", "decisions", "observation", "preferences", "projects", "team"];
const DOMAINS = ["work", "personal"];
const KINDS = ["fact", "summary", "distilled", "relation"];
const SOURCES = ["agent", "cortex", "system", "user", "portal"];
const SORT_OPTIONS = [
  { value: "", label: "Default order" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

interface BrowseResponse {
  results: Fact[];
  count: number;
  nextOffset: number | null;
}

interface SearchResponse {
  results: Fact[];
  count: number;
}

const PAGE_SIZE = 20;

export default function Memory() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [category, setCategory] = useState(searchParams.get("category") ?? "");
  const [domain, setDomain] = useState(searchParams.get("domain") ?? "");
  const [kind, setKind] = useState(searchParams.get("kind") ?? "");
  const [source, setSource] = useState(searchParams.get("source") ?? "");
  const [entity, setEntity] = useState(searchParams.get("entity") ?? "");
  const [sort, setSort] = useState(searchParams.get("sort") ?? "");
  const [since, setSince] = useState(searchParams.get("since") ?? "");
  const [until, setUntil] = useState(searchParams.get("until") ?? "");

  const [results, setResults] = useState<Fact[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");

  // Load stats on mount (shared cache → no double fetch with Dashboard)
  useEffect(() => {
    getStats().then(setStats).catch(() => {});
  }, []);

  const buildParams = useCallback(() => {
    const p: Record<string, string> = {};
    if (query) p.q = query;
    if (category) p.category = category;
    if (domain) p.domain = domain;
    if (kind) p.kind = kind;
    if (source) p.source = source;
    if (entity) p.entity = entity;
    if (sort) p.sort = sort;
    if (since) p.since = since;
    if (until) p.until = until;
    return p;
  }, [query, category, domain, kind, source, entity, sort, since, until]);

  const fetchResults = useCallback(
    async (append = false, offset = 0) => {
      setLoading(true);
      setError("");
      try {
        if (query.trim()) {
          const params = new URLSearchParams();
          params.set("q", query.trim());
          if (category) params.set("category", category);
          if (domain) params.set("domain", domain);
          if (kind) params.set("kind", kind);
          if (entity) params.set("entity", entity);
          params.set("limit", String(append ? results.length + PAGE_SIZE : PAGE_SIZE));

          const data = await apiFetch<SearchResponse>(`/api/memory/search?${params}`);
          // Client-side sort for search results (server returns by relevance)
          if (sort === "newest") data.results.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
          else if (sort === "oldest") data.results.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
          setResults(data.results);
          setTotalCount(data.count);
          setNextOffset(data.results.length < data.count ? data.results.length : null);
        } else {
          const params = new URLSearchParams();
          if (category) params.set("category", category);
          if (domain) params.set("domain", domain);
          if (kind) params.set("kind", kind);
          if (source) params.set("source", source);
          if (entity) params.set("entity", entity);
          if (sort) params.set("sort", sort);
          if (since) params.set("since", new Date(since).toISOString());
          if (until) params.set("until", new Date(until + "T23:59:59").toISOString());
          params.set("limit", String(PAGE_SIZE));
          if (append && offset) params.set("offset", String(offset));

          const data = await apiFetch<BrowseResponse>(`/api/memory/browse?${params}`);
          setResults(append ? [...results, ...data.results] : data.results);
          setTotalCount(data.count);
          setNextOffset(data.nextOffset);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to fetch");
      } finally {
        setLoading(false);
      }
    },
    [query, category, domain, kind, source, entity, sort, since, until, results],
  );

  // Initial load and filter changes
  useEffect(() => {
    fetchResults();
    setSearchParams(buildParams(), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, domain, kind, source, entity, sort, since, until]);

  const handleSearch = () => {
    setSearchParams(buildParams(), { replace: true });
    fetchResults();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const handleLoadMore = () => {
    fetchResults(true, nextOffset ?? 0);
  };

  const selectCls =
    "bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500";

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Memory</h2>
        {stats && (
          <div className="flex items-center gap-4 text-sm text-zinc-400">
            <span className="flex items-center gap-1.5">
              <Database size={14} />
              {stats.active.toLocaleString()} active
            </span>
            <span>{stats.superseded.toLocaleString()} superseded</span>
          </div>
        )}
      </div>

      {/* Search bar */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Search memory…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-md pl-9 pr-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={loading}
          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
        >
          Search
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={selectCls}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select value={domain} onChange={(e) => setDomain(e.target.value)} className={selectCls}>
          <option value="">All domains</option>
          {DOMAINS.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={selectCls}>
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className={selectCls}>
          <option value="">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {entity && (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-md text-sm text-zinc-300">
            entity: {entity}
            <button
              onClick={() => setEntity("")}
              className="ml-1 text-zinc-500 hover:text-zinc-300"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {/* Sort & date range */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <div className="flex items-center gap-1.5">
          <ArrowUpDown size={14} className="text-zinc-500" />
          <select value={sort} onChange={(e) => setSort(e.target.value)} className={selectCls}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5 text-sm text-zinc-400">
          <span>From</span>
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500 [color-scheme:dark]"
          />
          <span>to</span>
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-zinc-500 [color-scheme:dark]"
          />
          {(since || until) && (
            <button
              onClick={() => { setSince(""); setUntil(""); }}
              className="text-zinc-500 hover:text-zinc-300 text-xs ml-1"
            >
              Clear dates
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Results */}
      {loading && results.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-zinc-500">
          <Loader2 size={20} className="animate-spin mr-2" />
          Loading…
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-20 text-zinc-500">
          <Database size={32} className="mx-auto mb-3 opacity-50" />
          <p>No facts found</p>
          <p className="text-xs mt-1">Try adjusting your search or filters</p>
        </div>
      ) : (
        <>
          <p className="text-xs text-zinc-500 mb-3">
            Showing {results.length} of {totalCount.toLocaleString()} facts
          </p>
          <div className="space-y-2">
            {results.map((fact) => (
              <FactCard
                key={fact.id}
                fact={fact}
                onClick={() => navigate(`/memory/${fact.id}`)}
              />
            ))}
          </div>

          {/* Load more */}
          {nextOffset !== null && (
            <div className="mt-4 text-center">
              <button
                onClick={handleLoadMore}
                disabled={loading}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" /> Loading…
                  </span>
                ) : (
                  "Load more"
                )}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
