import Badge from "./Badge";
import { EntityChip } from "./EntityChip";
import { relativeTime, truncate, CATEGORY_COLORS, KIND_COLORS } from "../lib/format";
import { ontologyLabel } from "../lib/ontology";

export interface Fact {
  id: string;
  content: string;
  category: string;
  user_name?: string;
  domain?: string;
  kind?: string;
  memory_subtype?: string | null;
  actor_id?: string;
  entities: string[];
  source?: string;
  origin?: OperationOrigin | null;
  last_operation_origin?: OperationOrigin | null;
  confidence: number;
  created_at: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
  from_entity?: string;
  relation_type?: string;
  to_entity?: string;
  score?: number | null;
  usefulness_score?: number | null;
  usefulness_percent?: number | null;
  usefulness_rated_count?: number;
  useful_count?: number;
  not_useful_count?: number;
  misleading_count?: number;
  wrong_count?: number;
  irrelevant_count?: number;
  needs_review?: boolean;
  session_id?: string;
  workstream_key?: string;
  task_key?: string;
  episode_id?: string;
  repo?: string;
  branch?: string;
  _destination?: string;
}

interface OriginIdentity {
  type?: string | null;
  id?: string | null;
  name?: string | null;
  source?: string | null;
}

interface OperationOrigin {
  user?: OriginIdentity | null;
  agent?: OriginIdentity | null;
  interface?: string | null;
  operation?: {
    action?: string | null;
    tool?: string | null;
    route?: string | null;
    subsystem?: string | null;
  } | null;
}

interface FactCardProps {
  fact: Fact;
  onClick?: () => void;
}

export default function FactCard({ fact, onClick }: FactCardProps) {
  const userName = memoryUserName(fact);
  const origin = memoryOriginLabel(fact);

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
        <Badge label={`Category: ${ontologyLabel(fact.category)}`} color={CATEGORY_COLORS[fact.category]} />
        {fact._destination && (
          <Badge label={`📍 ${fact._destination}`} color="indigo" />
        )}
        {fact.usefulness_percent != null ? (
          <Badge label={`Useful ${fact.usefulness_percent}%`} color="green" />
        ) : (
          <Badge label="Unrated" color="zinc" />
        )}
        {fact.needs_review && <Badge label="Needs review" color="red" />}
        {fact.kind && fact.kind !== "fact" && (
          <Badge label={`Kind: ${ontologyLabel(fact.kind)}`} color={KIND_COLORS[fact.kind]} />
        )}
        {fact.memory_subtype && (
          <Badge label={`Type: ${ontologyLabel(fact.memory_subtype)}`} color={CATEGORY_COLORS[fact.category]} />
        )}
        {fact.domain && fact.domain !== "software_engineering" && (
          <Badge label={`Domain: ${ontologyLabel(fact.domain)}`} color="green" />
        )}
        {fact.entities.map((e) => (
          <EntityChip key={e} name={e} link={false} />
        ))}
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-zinc-500">
        <span>{relativeTime(fact.created_at)}</span>
        <span>{Math.round(fact.confidence * 100)}% conf</span>
        {userName && <ProvChip label="user" value={userName} />}
        {origin && <ProvChip label="origin" value={origin} />}
        {(fact.usefulness_rated_count ?? 0) > 0 && <span>{signalBreakdown(fact)}</span>}
        {fact.score != null && <span>score {fact.score.toFixed(3)}</span>}
        {fact.workstream_key && <ProvChip label="ws" value={fact.workstream_key} />}
        {fact.task_key && <ProvChip label="task" value={fact.task_key} />}
        {fact.repo && <ProvChip label="repo" value={fact.repo} />}
        {fact.branch && <ProvChip label="branch" value={fact.branch} />}
        {fact.actor_id && <ProvChip label="actor" value={fact.actor_id} />}
        {fact.session_id && <ProvChip label="session" value={fact.session_id.slice(0, 8)} />}
        {fact.episode_id && <ProvChip label="episode" value={fact.episode_id.slice(0, 8)} />}
      </div>
    </button>
  );
}

export function memoryUserName(fact: Fact): string | null {
  return nonEmpty(fact.user_name)
    ?? identityLabel(fact.origin?.user)
    ?? nonEmpty(fact.metadata?.actor_label)
    ?? identityLabel(fact.last_operation_origin?.user);
}

export function memoryOriginAgentLabel(fact: Fact): string | null {
  return identityLabel(fact.origin?.agent);
}

export function memoryOriginLabel(fact: Fact): string | null {
  return operationLabel(fact.origin) ?? nonEmpty(fact.source);
}

export function memoryLastOperationUserName(fact: Fact): string | null {
  return identityLabel(fact.last_operation_origin?.user);
}

export function memoryLastOperationLabel(fact: Fact): string | null {
  return operationLabel(fact.last_operation_origin);
}

function operationLabel(origin: OperationOrigin | null | undefined): string | null {
  const surface = nonEmpty(origin?.interface) ?? nonEmpty(origin?.agent?.type);
  const target = nonEmpty(origin?.operation?.subsystem) ?? nonEmpty(origin?.operation?.tool);
  const action = nonEmpty(origin?.operation?.action);
  const parts = [surface, target, action].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("/") : null;
}

function identityLabel(identity: OriginIdentity | null | undefined): string | null {
  return nonEmpty(identity?.name) ?? nonEmpty(identity?.id);
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function signalBreakdown(fact: Fact): string {
  const parts = [
    `${fact.useful_count ?? 0} useful`,
    `${fact.misleading_count ?? 0} misleading`,
    `${fact.wrong_count ?? 0} wrong`,
  ];
  if ((fact.not_useful_count ?? 0) > 0) parts.push(`${fact.not_useful_count} not useful`);
  if ((fact.irrelevant_count ?? 0) > 0) parts.push(`${fact.irrelevant_count} irrelevant`);
  return parts.join(" · ");
}

function ProvChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-400">
      <span className="text-[10px] uppercase tracking-wide opacity-70">{label}</span>
      <span className="font-mono text-[11px]">{value}</span>
    </span>
  );
}
