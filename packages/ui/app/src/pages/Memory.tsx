import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Search, Loader2, Database, ArrowUpDown } from "lucide-react";
import { apiFetch } from "../lib/api";
import { getStats, type MemoryStats as Stats } from "../lib/statsCache";
import FactCard, { type Fact } from "../components/FactCard";
import {
  CATEGORY_OPTIONS,
  DOMAIN_OPTIONS,
  KIND_OPTIONS,
  ONTOLOGY_GROUPS,
  SOURCE_OPTIONS,
  SUBTYPE_BY_VALUE,
  ontologyLabel,
} from "../lib/ontology";

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "", label: "Relevance / default" },
];

const DATE_PRESETS: { label: string; days: number }[] = [
  { label: "Today", days: 0 },
  { label: "Past 3 days", days: 2 },
  { label: "Past 7 days", days: 6 },
  { label: "Past month", days: 29 },
];

function presetSinceDate(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  // YYYY-MM-DD in local time (matches <input type="date"> value format)
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

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

interface ActiveFilter {
  key: string;
  label: string;
  value: string;
  onClear: () => void;
}

export default function Memory() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [category, setCategory] = useState(searchParams.get("category") ?? "");
  const [domain, setDomain] = useState(searchParams.get("domain") ?? "");
  const [kind, setKind] = useState(searchParams.get("kind") ?? "");
  const [memorySubtype, setMemorySubtype] = useState(searchParams.get("memory_subtype") ?? "");
  const [source, setSource] = useState(searchParams.get("source") ?? "");
  const [entity, setEntity] = useState(searchParams.get("entity") ?? "");
  const [sort, setSort] = useState(searchParams.get("sort") ?? "newest");
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
    if (memorySubtype) p.memory_subtype = memorySubtype;
    if (source) p.source = source;
    if (entity) p.entity = entity;
    if (sort) p.sort = sort;
    if (since) p.since = since;
    if (until) p.until = until;
    return p;
  }, [query, category, domain, kind, memorySubtype, source, entity, sort, since, until]);

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
          if (memorySubtype) params.set("memory_subtype", memorySubtype);
          if (source) params.set("source", source);
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
          if (memorySubtype) params.set("memory_subtype", memorySubtype);
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
    [query, category, domain, kind, memorySubtype, source, entity, sort, since, until, results],
  );

  // Initial load and filter changes
  useEffect(() => {
    fetchResults();
    setSearchParams(buildParams(), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, domain, kind, memorySubtype, source, entity, sort, since, until]);

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

  const applyCategory = (value: string) => {
    setCategory(value);
    setMemorySubtype("");
  };

  const applyKind = (value: string) => {
    setKind(value);
    setMemorySubtype("");
  };

  const applySubtype = (value: string) => {
    setMemorySubtype(value);
    if (value) {
      setCategory("");
      setKind("");
    }
  };

  const clearOntologyFilters = () => {
    setCategory("");
    setDomain("");
    setKind("");
    setMemorySubtype("");
    setSource("");
  };

  const clearAdvancedFilters = () => {
    setCategory("");
    setDomain("");
    setKind("");
    setSource("");
  };

  const clearAllFilters = () => {
    clearOntologyFilters();
    setEntity("");
    setSince("");
    setUntil("");
  };

  const pillCls = (active: boolean) =>
    "px-2 py-1 rounded-md border text-xs transition-colors " +
    (active
      ? "bg-zinc-700 border-zinc-500 text-zinc-100"
      : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200");

  const categoryCount = (value: string) => stats?.byCategory?.[value] ?? 0;
  const subtypeCount = (value: string) => stats?.bySubtype?.[value] ?? 0;
  const selectedSubtype = memorySubtype ? SUBTYPE_BY_VALUE[memorySubtype] : undefined;
  const activeFilters: ActiveFilter[] = [
    category ? { key: "category", label: "Category", value: ontologyLabel(category), onClear: () => setCategory("") } : null,
    domain ? { key: "domain", label: "Domain", value: ontologyLabel(domain), onClear: () => setDomain("") } : null,
    kind ? { key: "kind", label: "Kind", value: ontologyLabel(kind), onClear: () => setKind("") } : null,
    memorySubtype ? {
      key: "memory_subtype",
      label: "Subtype",
      value: selectedSubtype?.label ?? ontologyLabel(memorySubtype),
      onClear: () => setMemorySubtype(""),
    } : null,
    source ? { key: "source", label: "Source", value: ontologyLabel(source), onClear: () => setSource("") } : null,
    entity ? { key: "entity", label: "Entity", value: entity, onClear: () => setEntity("") } : null,
    since ? { key: "since", label: "From", value: since, onClear: () => setSince("") } : null,
    until ? { key: "until", label: "Until", value: until, onClear: () => setUntil("") } : null,
  ].filter((filter): filter is ActiveFilter => filter !== null);

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

      {activeFilters.length > 0 && (
        <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Active filters</span>
            {activeFilters.map((filter) => (
              <ActiveFilterChip key={filter.key} filter={filter} />
            ))}
            <button
              type="button"
              onClick={clearAllFilters}
              className="ml-auto text-xs text-zinc-500 hover:text-zinc-300"
            >
              Clear all
            </button>
          </div>
          {selectedSubtype && (
            <p className="mt-2 text-xs text-zinc-500">
              Subtype is an ontology field. It filters by <span className="text-zinc-300">{selectedSubtype.label}</span> without also requiring a category or kind filter.
            </p>
          )}
        </div>
      )}

      {/* Ontology navigation */}
      <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">Browse by category and subtype</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Categories are broad ontology buckets. Subtypes are narrower ontology buckets for specific memory shapes.
            </p>
          </div>
          {memorySubtype && (
            <button
              type="button"
              onClick={() => setMemorySubtype("")}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Clear subtype
            </button>
          )}
        </div>
        {selectedSubtype && (
          <div className="mb-4 rounded-md border border-blue-500/20 bg-blue-500/10 px-3 py-2">
            <p className="text-sm text-blue-200">
              Showing subtype: <span className="font-medium">{selectedSubtype.label}</span>
            </p>
            <p className="mt-0.5 text-xs text-blue-200/70">{selectedSubtype.description}</p>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {ONTOLOGY_GROUPS.map((group) => (
            <div key={group.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <p className="text-sm font-medium text-zinc-200">{group.label}</p>
              <p className="text-xs text-zinc-500 mt-1 min-h-8">{group.description}</p>
              <p className="mt-3 text-[10px] font-medium uppercase tracking-wide text-zinc-600">Categories</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {group.categories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => applyCategory(cat)}
                    className={pillCls(category === cat && !memorySubtype)}
                    title={`${categoryCount(cat).toLocaleString()} facts`}
                  >
                    {ontologyLabel(cat)}
                    {stats && <span className="ml-1 text-zinc-500">{categoryCount(cat).toLocaleString()}</span>}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[10px] font-medium uppercase tracking-wide text-zinc-600">Subtypes</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {group.subtypes.map((subtypeValue) => {
                  const subtype = SUBTYPE_BY_VALUE[subtypeValue];
                  if (!subtype) return null;
                  return (
                    <button
                      key={subtype.value}
                      type="button"
                      onClick={() => applySubtype(subtype.value)}
                      className={pillCls(memorySubtype === subtype.value)}
                      title={subtype.description}
                    >
                      {subtype.label}
                      {stats && <span className="ml-1 text-zinc-500">{subtypeCount(subtype.value).toLocaleString()}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Advanced filters */}
      <details className="mb-6 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3" defaultOpen={Boolean(category || domain || kind || source)}>
        <summary className="cursor-pointer text-sm font-medium text-zinc-300">
          Advanced filters
          <span className="ml-2 text-xs font-normal text-zinc-500">category, domain, kind, and source</span>
        </summary>
        <div className="mt-3 flex flex-wrap gap-2">
          <select value={category} onChange={(e) => applyCategory(e.target.value)} className={selectCls}>
            <option value="">All categories</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          <select value={domain} onChange={(e) => setDomain(e.target.value)} className={selectCls}>
            <option value="">All domains</option>
            {DOMAIN_OPTIONS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
          <select value={kind} onChange={(e) => applyKind(e.target.value)} className={selectCls}>
            <option value="">All kinds</option>
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} className={selectCls}>
            <option value="">All sources</option>
            {SOURCE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          {(category || domain || kind || source) && (
            <button
              type="button"
              onClick={clearAdvancedFilters}
              className="px-2.5 py-1.5 rounded-md text-sm text-zinc-500 hover:text-zinc-300"
            >
              Clear advanced
            </button>
          )}
        </div>
      </details>

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
        <div className="flex items-center gap-1 text-xs">
          {DATE_PRESETS.map((p) => {
            const presetSince = presetSinceDate(p.days);
            const active = since === presetSince && !until;
            return (
              <button
                key={p.label}
                onClick={() => { setSince(presetSince); setUntil(""); }}
                className={
                  "px-2 py-1 rounded-md border transition-colors " +
                  (active
                    ? "bg-zinc-700 border-zinc-600 text-zinc-100"
                    : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200")
                }
              >
                {p.label}
              </button>
            );
          })}
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

function ActiveFilterChip({ filter }: { filter: ActiveFilter }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
      <span className="text-zinc-500">{filter.label}</span>
      <span>{filter.value}</span>
      <button
        type="button"
        onClick={filter.onClear}
        className="text-zinc-500 hover:text-zinc-200"
        aria-label={`Clear ${filter.label} filter`}
      >
        ×
      </button>
    </span>
  );
}
