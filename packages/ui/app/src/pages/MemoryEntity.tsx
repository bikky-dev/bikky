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
}

export default function MemoryEntity() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();

  const [data, setData] = useState<EntityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!name) return;
    setLoading(true);
    setError("");
    apiFetch<EntityResponse>(`/api/memory/entities/${encodeURIComponent(name)}`)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load entity"))
      .finally(() => setLoading(false));
  }, [name]);

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
            {data.factCount} facts · {data.relationCount} relations
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
          </div>
        )}
      </div>
    </div>
  );
}