import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Search, Loader2, Database, ArrowUpDown } from "lucide-react";
import { apiFetch } from "../lib/api";
import { useDestination } from "../lib/useDestination";
import { getStats, type MemoryStats as Stats } from "../lib/statsCache";
import FactCard, { type Fact } from "../components/FactCard";
import {
  BROWSABLE_CATEGORY_OPTIONS,
  BROWSABLE_SUBTYPES_BY_CATEGORY,
  SUBTYPE_BY_VALUE,
  ontologyLabel,
} from "../lib/ontology";

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "usefulness_desc", label: "Most useful" },
  { value: "usefulness_asc", label: "Least useful" },
  { value: "", label: "Relevance / default" },
];

const USEFULNESS_FILTER_OPTIONS = [
  { value: "", label: "All usefulness" },
  { value: "positive", label: "Has useful feedback" },
  { value: "needs_review", label: "Needs review" },
  { value: "no_useful", label: "No useful signal" },
  { value: "unrated", label: "Unrated" },
];

const DATE_PRESETS: { label: string; days: number }[] = [
  { label: "Today", days: 0 },
  { label: "Past 3 days", days: 2 },
  { label: "Past 7 days", days: 6 },
  { label: "Past month", days: 29 },
];

function isBrowsableCategory(value: string): boolean {
  return BROWSABLE_CATEGORY_OPTIONS.some((category) => category.value === value);
}

function isBrowsableSubtype(value: string): boolean {
  const subtype = SUBTYPE_BY_VALUE[value];
  return Boolean(subtype && subtype.category !== "system");
}

function parseParamList(raw: string | null, isAllowed: (value: string) => boolean): string[] {
  if (!raw) return [];
  return raw.split(",").map((value) => value.trim()).filter((value, index, values) =>
    Boolean(value) && isAllowed(value) && values.indexOf(value) === index,
  );
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

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
  const initialCategories = parseParamList(searchParams.get("category"), isBrowsableCategory);
  const initialSubtypes = parseParamList(searchParams.get("memory_subtype"), isBrowsableSubtype);
  const [categories, setCategories] = useState<string[]>(initialCategories);
  const [memorySubtypes, setMemorySubtypes] = useState<string[]>(initialSubtypes);
  const [entity, setEntity] = useState(searchParams.get("entity") ?? "");
  const [sort, setSort] = useState(searchParams.get("sort") ?? "newest");
  const [usefulness, setUsefulness] = useState(searchParams.get("usefulness") ?? "");
  const [since, setSince] = useState(searchParams.get("since") ?? "");
  const [until, setUntil] = useState(searchParams.get("until") ?? "");
  const [browseRevision, setBrowseRevision] = useState(0);

  const [results, setResults] = useState<Fact[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const destination = useDestination();

  useEffect(() => {
    let cancelled = false;
    getStats()
      .then((nextStats) => {
        if (!cancelled) setStats(nextStats);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [destination]);

  const buildParams = useCallback(() => {
    const p: Record<string, string> = {};
    if (query) p.q = query;
    if (categories.length) p.category = categories.join(",");
    if (memorySubtypes.length) p.memory_subtype = memorySubtypes.join(",");
    if (entity) p.entity = entity;
    if (sort) p.sort = sort;
    if (usefulness) p.usefulness = usefulness;
    if (since) p.since = since;
    if (until) p.until = until;
    return p;
  }, [query, categories, memorySubtypes, entity, sort, usefulness, since, until]);

  const fetchResults = useCallback(
    async (append = false, offset = 0) => {
      setLoading(true);
      setError("");
      try {
        if (query.trim()) {
          const params = new URLSearchParams();
          params.set("q", query.trim());
          if (categories.length) params.set("category", categories.join(","));
          if (memorySubtypes.length) params.set("memory_subtype", memorySubtypes.join(","));
          if (entity) params.set("entity", entity);
          if (sort) params.set("sort", sort);
          if (usefulness) params.set("usefulness", usefulness);
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
          if (categories.length) params.set("category", categories.join(","));
          if (memorySubtypes.length) params.set("memory_subtype", memorySubtypes.join(","));
          if (entity) params.set("entity", entity);
          if (sort) params.set("sort", sort);
          if (usefulness) params.set("usefulness", usefulness);
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
    [query, categories, memorySubtypes, entity, sort, usefulness, since, until, results],
  );

  // Initial load and filter changes
  useEffect(() => {
    fetchResults();
    setSearchParams(buildParams(), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, memorySubtypes, entity, sort, usefulness, since, until, browseRevision, destination]);

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
    setQuery("");
    setCategories((current) => toggleValue(current, value));
    setBrowseRevision((revision) => revision + 1);
  };

  const applySubtype = (value: string) => {
    setQuery("");
    setMemorySubtypes((current) => toggleValue(current, value));
    setBrowseRevision((revision) => revision + 1);
  };

  const clearOntologyFilters = () => {
    setCategories([]);
    setMemorySubtypes([]);
  };

  const clearAllFilters = () => {
    clearOntologyFilters();
    setEntity("");
    setUsefulness("");
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
  const usefulnessLabel = USEFULNESS_FILTER_OPTIONS.find((option) => option.value === usefulness)?.label ?? usefulness;
  const activeFilters: ActiveFilter[] = [
    ...categories.map((category) => ({
      key: `category:${category}`,
      label: "Category",
      value: `${ontologyLabel(category)} (${categoryCount(category).toLocaleString()})`,
      onClear: () => setCategories((current) => current.filter((item) => item !== category)),
    })),
    ...memorySubtypes.map((subtype) => ({
      key: `memory_subtype:${subtype}`,
      label: "Subtype",
      value: `${SUBTYPE_BY_VALUE[subtype]?.label ?? ontologyLabel(subtype)} (${subtypeCount(subtype).toLocaleString()})`,
      onClear: () => setMemorySubtypes((current) => current.filter((item) => item !== subtype)),
    })),
    entity ? { key: "entity", label: "Entity", value: entity, onClear: () => setEntity("") } : null,
    usefulness ? { key: "usefulness", label: "Usefulness", value: usefulnessLabel, onClear: () => setUsefulness("") } : null,
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
            {stats.superseded > 0 && <span>{stats.superseded.toLocaleString()} superseded</span>}
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
        </div>
      )}

      {/* Ontology navigation */}
      <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">Browse by category and subtype</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Pick a top-level category or a concrete subtype. There are no extra groups or sub-tabs.
            </p>
          </div>
          {memorySubtypes.length > 0 && (
            <button
              type="button"
              onClick={() => setMemorySubtypes([])}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Clear subtypes
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {BROWSABLE_CATEGORY_OPTIONS.map((cat) => (
            <div key={cat.value} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-zinc-200">{cat.label}</p>
                  <p className="text-xs text-zinc-500 mt-1 min-h-8">{cat.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => applyCategory(cat.value)}
                  className={pillCls(categories.includes(cat.value))}
                  title={`${categoryCount(cat.value).toLocaleString()} facts`}
                >
                  {categories.includes(cat.value) ? "Selected" : "Add"}
                  {stats && <span className="ml-1 text-zinc-500">{categoryCount(cat.value).toLocaleString()}</span>}
                </button>
              </div>
              <p className="mt-3 text-[10px] font-medium uppercase tracking-wide text-zinc-600">Subtypes</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(BROWSABLE_SUBTYPES_BY_CATEGORY[cat.value] ?? []).map((subtype) => {
                  return (
                    <button
                      key={subtype.value}
                      type="button"
                      onClick={() => applySubtype(subtype.value)}
                      className={pillCls(memorySubtypes.includes(subtype.value))}
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
        <select value={usefulness} onChange={(e) => setUsefulness(e.target.value)} className={selectCls}>
          {USEFULNESS_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
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
