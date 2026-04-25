import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router";
import { ArrowLeft, Loader2, Database, ArrowRight } from "lucide-react";
import { apiFetch, ApiError } from "../lib/api";
import FactCard, { type Fact } from "../components/FactCard";

interface Relation {
  from: string;
  type: string;
  to: string;
}

interface EntityResponse {
  entity: string;
  facts: Fact[];
  relations: Relation[];
  factCount: number;
  relationCount: number;
  factsTotal: number | null;
  relationsTotal: number | null;
  factsTruncated: boolean;
  factsNextOffset: string | null;
  relationsTruncated: boolean;
  limit: number;
}

const FACTS_PAGE_SIZE = 50;

export default function MemoryEntity() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();

  const [data, setData] = useState<EntityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!name) return;
    setLoading(true);
    setError("");
    apiFetch<EntityResponse>(
      `/api/memory/entities/${encodeURIComponent(name)}?limit=${FACTS_PAGE_SIZE}`,
    )
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load entity"))
      .finally(() => setLoading(false));
  }, [name]);

  const loadMoreFacts = async () => {
    if (!data || !data.factsNextOffset || !name) return;
    setLoadingMore(true);
    try {
      const more = await apiFetch<EntityResponse>(
        `/api/memory/entities/${encodeURIComponent(name)}?limit=${FACTS_PAGE_SIZE}&offset=${encodeURIComponent(data.factsNextOffset)}`,
      );
      setData({
        ...data,
        facts: [...data.facts, ...more.facts],
        factCount: data.facts.length + more.facts.length,
        factsTruncated: more.factsTruncated,
        factsNextOffset: more.factsNextOffset,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load more facts");
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-zinc-500">
        <Loader2 size={20} className="animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <button onClick={() => navigate("/memory")} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white mb-6">
          <ArrowLeft size={16} /> Back to Memory
        </button>
        <div className="px-4 py-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/memory")} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white">
            <ArrowLeft size={16} />
          </button>
          <h2 className="text-2xl font-bold">{data.entity}</h2>
          <span className="text-sm text-zinc-500">
            {data.factsTotal !== null && data.factsTotal !== data.factCount
              ? `${data.factCount} of ${data.factsTotal} facts`
              : `${data.factCount} facts`}
            {" · "}
            {data.relationsTotal !== null && data.relationsTotal !== data.relationCount
              ? `${data.relationCount} of ${data.relationsTotal} relations`
              : `${data.relationCount} relations`}
          </span>
        </div>
        <Link
          to={`/memory?entity=${encodeURIComponent(data.entity)}`}
          className="text-sm text-zinc-400 hover:text-white"
        >
          Search facts →
        </Link>
      </div>

      {/* Relations */}
      {data.relations.length > 0 && (
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">
            Relations
            {data.relationsTruncated && (
              <span className="ml-2 text-xs font-normal text-amber-400 normal-case tracking-normal">
                (showing first {data.relations.length} — more exist)
              </span>
            )}
          </h3>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 divide-y divide-zinc-800">
            {data.relations.map((r, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 text-sm">
                <Link
                  to={`/memory/entities/${encodeURIComponent(r.from)}`}
                  className={`hover:underline ${r.from === data.entity ? "text-zinc-300" : "text-blue-400"}`}
                >
                  {r.from}
                </Link>
                <ArrowRight size={14} className="text-zinc-600 shrink-0" />
                <span className="px-2 py-0.5 rounded bg-orange-500/15 text-orange-400 text-xs font-medium">
                  {r.type}
                </span>
                <ArrowRight size={14} className="text-zinc-600 shrink-0" />
                <Link
                  to={`/memory/entities/${encodeURIComponent(r.to)}`}
                  className={`hover:underline ${r.to === data.entity ? "text-zinc-300" : "text-blue-400"}`}
                >
                  {r.to}
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Facts */}
      <div>
        <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Facts
        </h3>
        {data.facts.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            <Database size={28} className="mx-auto mb-2 opacity-50" />
            <p>No facts for this entity</p>
          </div>
        ) : (
          <div className="space-y-2">
            {data.facts.map((fact) => (
              <FactCard
                key={fact.id}
                fact={fact}
                onClick={() => navigate(`/memory/${fact.id}`)}
              />
            ))}
            {data.factsTruncated && (
              <button
                onClick={loadMoreFacts}
                disabled={loadingMore}
                className="w-full mt-3 py-2 text-sm rounded-md border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loadingMore && <Loader2 size={14} className="animate-spin" />}
                {loadingMore ? "Loading…" : `Load more (${data.factsTotal ? data.factsTotal - data.facts.length : "more"})`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}