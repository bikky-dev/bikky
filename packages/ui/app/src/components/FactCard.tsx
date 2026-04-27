import Badge from "./Badge";
import { EntityChip } from "./EntityChip";
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
  session_id?: string;
  workstream_key?: string;
  task_key?: string;
  episode_id?: string;
  repo?: string;
  branch?: string;
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
          <EntityChip key={e} name={e} link={false} />
        ))}
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-zinc-500">
        <span>{relativeTime(fact.created_at)}</span>
        <span>{Math.round(fact.confidence * 100)}% conf</span>
        {fact.score != null && <span>score {fact.score.toFixed(3)}</span>}
        {fact.workstream_key && <ProvChip label="ws" value={fact.workstream_key} />}
        {fact.task_key && <ProvChip label="task" value={fact.task_key} />}
        {fact.repo && <ProvChip label="repo" value={fact.repo} />}
        {fact.branch && <ProvChip label="branch" value={fact.branch} />}
        {fact.session_id && <ProvChip label="session" value={fact.session_id.slice(0, 8)} />}
        {fact.episode_id && <ProvChip label="episode" value={fact.episode_id.slice(0, 8)} />}
      </div>
    </button>
  );
}

function ProvChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-400">
      <span className="text-[10px] uppercase tracking-wide opacity-70">{label}</span>
      <span className="font-mono text-[11px]">{value}</span>
    </span>
  );
}
