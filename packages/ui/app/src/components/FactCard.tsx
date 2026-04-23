import Badge from "./Badge";
import { relativeTime, truncate, CATEGORY_COLORS, KIND_COLORS } from "../lib/format";

export interface Fact {
  id: string;
  content: string;
  category: string;
  domain?: string;
  kind?: string;
  entities: string[];
  source?: string;
  confidence: number;
  created_at: string;
  updated_at?: string;
  from_entity?: string;
  relation_type?: string;
  to_entity?: string;
  score?: number | null;
}

interface FactCardProps {
  fact: Fact;
  onClick?: () => void;
}

export default function FactCard({ fact, onClick }: FactCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-lg border border-zinc-800 bg-zinc-900 p-4 hover:border-zinc-700 hover:bg-zinc-900/80 transition-colors"
    >
      <p className="text-sm text-zinc-200 leading-relaxed">
        {truncate(fact.content, 200)}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge label={fact.category} color={CATEGORY_COLORS[fact.category]} />
        {fact.kind && fact.kind !== "fact" && (
          <Badge label={fact.kind} color={KIND_COLORS[fact.kind]} />
        )}
        {fact.domain && fact.domain !== "work" && (
          <Badge label={fact.domain} color="green" />
        )}
        {fact.entities.map((e) => (
          <span
            key={e}
            className="inline-flex items-center px-2 py-0.5 rounded text-xs text-zinc-400 bg-zinc-800"
          >
            {e}
          </span>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-zinc-500">
        <span>{relativeTime(fact.created_at)}</span>
        <span>{Math.round(fact.confidence * 100)}% conf</span>
        {fact.score != null && <span>score {fact.score.toFixed(3)}</span>}
      </div>
    </button>
  );
}
