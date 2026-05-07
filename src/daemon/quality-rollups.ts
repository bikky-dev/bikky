/**
 * Backend aggregation for memory quality telemetry.
 */

import { createHash } from "node:crypto";

import type { BikkyConfig, Destination } from "../config.js";
import { contentHash, computeEffectiveConfidence } from "../mcp/helpers.js";
import type { FactPayload } from "../mcp/types.js";
import { categoryForMemorySubtype, layerForMemorySubtype } from "../mcp/taxonomy.js";
import { buildOperationOrigin } from "../provenance/origin.js";
import {
  readMaintenanceState,
  recordMaintenanceRun,
  shouldRunMaintenance,
} from "./maintenance-state.js";
import * as qdrant from "./qdrant.js";
import type { LogFn } from "./qdrant.js";

const SCROLL_LIMIT = 256;
const ROLLUP_TYPE = "latest";
const JOB_NAME = "memory_quality_rollups";

let logFn: LogFn = () => {};

export type QualityScopeType =
  | "destination"
  | "repo"
  | "workstream_key"
  | "task_key"
  | "entity"
  | "origin_user"
  | "origin_agent";

export interface QualityPoint {
  id: string;
  destination: string;
  payload: Partial<FactPayload>;
}

export interface QualityRollup {
  destination: string;
  scope_type: QualityScopeType;
  scope_value: string;
  active_fact_count: number;
  recall_count: number;
  useful_count: number;
  misleading_count: number;
  wrong_count: number;
  stale_count: number;
  low_confidence_count: number;
  generated_at: string;
  source_fact_ids: string[];
  source_event_ids: string[];
}

export interface QualityRollupResult {
  destinations_seen: number;
  facts_seen: number;
  events_seen: number;
  rollups_upserted: number;
  scopes_capped: boolean;
}

export interface QualityRollupDeps {
  isReady: () => boolean;
  activeDestinations: () => Destination[];
  qdrantRequest: (
    method: string,
    urlPath: string,
    body?: unknown,
    destinationRef?: Destination | string | null,
  ) => Promise<Record<string, unknown>>;
  embed: (text: string) => Promise<number[]>;
}

interface Scope {
  type: QualityScopeType;
  value: string;
}

interface MutableRollup extends Omit<QualityRollup, "source_fact_ids" | "source_event_ids"> {
  sourceFactIds: Set<string>;
  sourceEventIds: Set<string>;
}

interface ScrollPoint {
  id: string;
  payload?: Record<string, unknown>;
}

interface ScrollResponse {
  result?: {
    points?: ScrollPoint[];
    next_page_offset?: string | number | null;
  };
}

const defaultDeps: QualityRollupDeps = {
  isReady: qdrant.isReady,
  activeDestinations: qdrant.activeDestinations,
  qdrantRequest: qdrant.qdrantRequest,
  embed: qdrant.embed,
};

export const setLogger = (fn: LogFn): void => {
  logFn = fn;
};

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const numberValue = (value: unknown): number => (
  typeof value === "number" && Number.isFinite(value) ? value : 0
);

const stringArray = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map((item) => nonEmptyString(item)).filter((item): item is string => item !== null)
    : []
);

const stableUuid = (input: string): string => {
  const hash = createHash("sha256").update(input).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
};

const completePayload = (payload: Partial<FactPayload>): FactPayload => ({
  ...payload,
  content: payload.content ?? "",
  category: payload.category ?? "engineering",
  domain: payload.domain ?? "software_engineering",
  kind: payload.kind ?? "fact",
  memory_subtype: payload.memory_subtype ?? null,
  entities: payload.entities ?? [],
  confidence: typeof payload.confidence === "number" ? payload.confidence : 0.7,
  content_hash: payload.content_hash ?? "",
  reinforcement_count: payload.reinforcement_count ?? 1,
  last_reinforced_at: payload.last_reinforced_at ?? payload.created_at ?? "",
  superseded_by: payload.superseded_by ?? null,
  superseded_at: payload.superseded_at ?? null,
  created_at: payload.created_at ?? "",
  updated_at: payload.updated_at ?? payload.created_at ?? "",
});

const daysBetween = (now: Date, iso: string | undefined | null): number => {
  if (!iso) return 0;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, (now.getTime() - timestamp) / 86_400_000);
};

const isFactStale = (payload: FactPayload, now: Date, thresholdDays: number): boolean => {
  const activity = payload.last_verified_at ?? payload.last_reinforced_at ?? payload.created_at;
  if (!activity) return false;
  return daysBetween(now, activity) > thresholdDays;
};

const scopesForFact = (fact: QualityPoint): Scope[] => {
  const scopes: Scope[] = [{ type: "destination", value: fact.destination }];
  const add = (type: QualityScopeType, value: unknown): void => {
    const normalized = nonEmptyString(value);
    if (normalized) scopes.push({ type, value: normalized });
  };

  add("repo", fact.payload.repo);
  add("workstream_key", fact.payload.workstream_key);
  add("task_key", fact.payload.task_key);
  for (const entity of fact.payload.entities ?? []) add("entity", entity);
  add("origin_user", fact.payload.origin?.user?.id);
  add("origin_agent", fact.payload.origin?.agent?.id);

  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = `${scope.type}\0${scope.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const rollupKey = (destination: string, scope: Scope): string => `${destination}\0${scope.type}\0${scope.value}`;

const getRollup = (
  rollups: Map<string, MutableRollup>,
  destination: string,
  scope: Scope,
  generatedAt: string,
): MutableRollup => {
  const key = rollupKey(destination, scope);
  const existing = rollups.get(key);
  if (existing) return existing;
  const created: MutableRollup = {
    destination,
    scope_type: scope.type,
    scope_value: scope.value,
    active_fact_count: 0,
    recall_count: 0,
    useful_count: 0,
    misleading_count: 0,
    wrong_count: 0,
    stale_count: 0,
    low_confidence_count: 0,
    generated_at: generatedAt,
    sourceFactIds: new Set<string>(),
    sourceEventIds: new Set<string>(),
  };
  rollups.set(key, created);
  return created;
};

const addEventSignal = (
  rollups: Map<string, MutableRollup>,
  scopes: Scope[],
  destination: string,
  generatedAt: string,
  eventId: string,
  update: (rollup: MutableRollup) => void,
): void => {
  for (const scope of scopes) {
    const rollup = getRollup(rollups, destination, scope, generatedAt);
    update(rollup);
    rollup.sourceEventIds.add(eventId);
  }
};

export const buildQualityRollups = (input: {
  facts: QualityPoint[];
  events?: QualityPoint[];
  generatedAt?: Date;
  staleThresholdDays?: number;
  lowConfidenceThreshold?: number;
}): QualityRollup[] => {
  const now = input.generatedAt ?? new Date();
  const generatedAt = now.toISOString();
  const staleThresholdDays = input.staleThresholdDays ?? 30;
  const lowConfidenceThreshold = input.lowConfidenceThreshold ?? 0.6;
  const factsById = new Map(input.facts.map((fact) => [fact.id, fact]));
  const scopesByFactId = new Map(input.facts.map((fact) => [fact.id, scopesForFact(fact)]));
  const rollups = new Map<string, MutableRollup>();

  for (const fact of input.facts) {
    const payload = completePayload(fact.payload);
    const scopes = scopesByFactId.get(fact.id) ?? [];
    for (const scope of scopes) {
      const rollup = getRollup(rollups, fact.destination, scope, generatedAt);
      rollup.active_fact_count++;
      rollup.recall_count += numberValue(payload.recall_count);
      rollup.useful_count += numberValue(payload.useful_count ?? payload.useful_feedback_count);
      if (isFactStale(payload, now, staleThresholdDays)) rollup.stale_count++;
      if (computeEffectiveConfidence(payload) < lowConfidenceThreshold) rollup.low_confidence_count++;
      rollup.sourceFactIds.add(fact.id);
    }
  }

  for (const event of input.events ?? []) {
    const subtype = event.payload.memory_subtype;
    if (subtype === "recall_event") {
      for (const factId of stringArray(event.payload.returned_fact_ids)) {
        const fact = factsById.get(factId);
        if (!fact || typeof fact.payload.recall_count === "number") continue;
        addEventSignal(
          rollups,
          scopesByFactId.get(factId) ?? [],
          fact.destination,
          generatedAt,
          event.id,
          (rollup) => { rollup.recall_count++; },
        );
      }
      continue;
    }

    const targetFactId = nonEmptyString(event.payload.target_fact_id);
    if (!targetFactId) continue;
    const targetFact = factsById.get(targetFactId);
    if (!targetFact) continue;
    const targetScopes = scopesByFactId.get(targetFactId) ?? [];

    if (subtype === "feedback_event" && event.payload.feedback_kind === "useful") {
      if (typeof targetFact.payload.useful_count === "number" || typeof targetFact.payload.useful_feedback_count === "number") {
        continue;
      }
      addEventSignal(
        rollups,
        targetScopes,
        targetFact.destination,
        generatedAt,
        event.id,
        (rollup) => { rollup.useful_count++; },
      );
      continue;
    }

    if (subtype === "outcome_event" && (event.payload.outcome === "misleading" || event.payload.outcome === "wrong")) {
      addEventSignal(
        rollups,
        targetScopes,
        targetFact.destination,
        generatedAt,
        event.id,
        (rollup) => {
          if (event.payload.outcome === "misleading") rollup.misleading_count++;
          if (event.payload.outcome === "wrong") rollup.wrong_count++;
        },
      );
    }
  }

  return [...rollups.values()]
    .map((rollup) => ({
      destination: rollup.destination,
      scope_type: rollup.scope_type,
      scope_value: rollup.scope_value,
      active_fact_count: rollup.active_fact_count,
      recall_count: rollup.recall_count,
      useful_count: rollup.useful_count,
      misleading_count: rollup.misleading_count,
      wrong_count: rollup.wrong_count,
      stale_count: rollup.stale_count,
      low_confidence_count: rollup.low_confidence_count,
      generated_at: rollup.generated_at,
      source_fact_ids: [...rollup.sourceFactIds].sort().slice(0, 100),
      source_event_ids: [...rollup.sourceEventIds].sort().slice(0, 100),
    }))
    .sort((a, b) => `${a.scope_type}:${a.scope_value}`.localeCompare(`${b.scope_type}:${b.scope_value}`));
};

const scrollAllPoints = async (
  deps: QualityRollupDeps,
  destination: Destination,
  filter: Record<string, unknown>,
): Promise<QualityPoint[]> => {
  const points: QualityPoint[] = [];
  let offset: string | number | null | undefined;
  do {
    const body = {
      filter,
      limit: SCROLL_LIMIT,
      with_payload: true,
      ...(offset !== undefined && offset !== null ? { offset } : {}),
    };
    const response = await deps.qdrantRequest(
      "POST",
      `/collections/${destination.collection}/points/scroll`,
      body,
      destination,
    ) as ScrollResponse;
    for (const point of response.result?.points ?? []) {
      points.push({
        id: point.id,
        destination: destination.name,
        payload: (point.payload ?? {}) as Partial<FactPayload>,
      });
    }
    offset = response.result?.next_page_offset;
  } while (offset !== undefined && offset !== null);
  return points;
};

const fetchQualityInputs = async (
  deps: QualityRollupDeps,
  destination: Destination,
): Promise<{ facts: QualityPoint[]; events: QualityPoint[] }> => {
  const facts = await scrollAllPoints(deps, destination, {
    must: [{ is_null: { key: "superseded_by" } }],
    must_not: [{ key: "kind", match: { any: ["telemetry", "entity_type"] } }],
  });
  const events = await scrollAllPoints(deps, destination, {
    must: [
      { key: "kind", match: { value: "telemetry" } },
      { key: "memory_subtype", match: { any: ["feedback_event", "outcome_event", "recall_event"] } },
    ],
  });
  return { facts, events };
};

const rollupContent = (rollup: QualityRollup): string => (
  `Memory quality rollup for ${rollup.scope_type}:${rollup.scope_value}: ` +
  `${rollup.active_fact_count} active facts, ${rollup.recall_count} recalls, ` +
  `${rollup.useful_count} useful, ${rollup.misleading_count} misleading, ` +
  `${rollup.wrong_count} wrong, ${rollup.stale_count} stale, ` +
  `${rollup.low_confidence_count} low-confidence.`
);

const rollupId = (rollup: QualityRollup): string => stableUuid(
  `aggregate_rollup:${ROLLUP_TYPE}:${rollup.destination}:${rollup.scope_type}:${rollup.scope_value}`,
);

const rollupPayload = (rollup: QualityRollup): Record<string, unknown> => {
  const content = rollupContent(rollup);
  return {
    content,
    category: categoryForMemorySubtype("aggregate_rollup") ?? "system",
    domain: "software_engineering",
    kind: "telemetry",
    memory_subtype: "aggregate_rollup",
    layer: layerForMemorySubtype("aggregate_rollup") ?? "workspace",
    entities: rollup.scope_type === "entity" ? [rollup.scope_value.toLowerCase()] : [],
    origin: buildOperationOrigin({
      interface: "daemon",
      action: "aggregate",
      subsystem: "memory_quality_rollups",
      metadata: {
        destination: rollup.destination,
        scope_type: rollup.scope_type,
        scope_value: rollup.scope_value,
      },
    }),
    confidence: 1.0,
    importance: 0.4,
    content_hash: contentHash("aggregate_rollup", `${ROLLUP_TYPE}:${rollup.destination}:${rollup.scope_type}:${rollup.scope_value}`),
    reinforcement_count: 1,
    last_reinforced_at: rollup.generated_at,
    superseded_by: null,
    superseded_at: null,
    created_at: rollup.generated_at,
    updated_at: rollup.generated_at,
    rollup_type: ROLLUP_TYPE,
    rollup_generated_at: rollup.generated_at,
    rollup_window_end: rollup.generated_at,
    scope_type: rollup.scope_type,
    scope_value: rollup.scope_value,
    active_fact_count: rollup.active_fact_count,
    recall_count: rollup.recall_count,
    useful_count: rollup.useful_count,
    misleading_count: rollup.misleading_count,
    wrong_count: rollup.wrong_count,
    stale_count: rollup.stale_count,
    low_confidence_count: rollup.low_confidence_count,
    source_fact_ids: rollup.source_fact_ids,
    source_event_ids: rollup.source_event_ids,
    metadata: {
      generated_by: "memory_quality_rollups",
      rollup_type: ROLLUP_TYPE,
    },
  };
};

const upsertRollup = async (
  deps: QualityRollupDeps,
  destination: Destination,
  rollup: QualityRollup,
): Promise<void> => {
  const payload = rollupPayload(rollup);
  const vector = await deps.embed(String(payload.content));
  await deps.qdrantRequest("PUT", `/collections/${destination.collection}/points`, {
    points: [{ id: rollupId(rollup), vector, payload }],
  }, destination);
};

export const aggregateMemoryQualitySignals = async (
  config: BikkyConfig,
  deps: QualityRollupDeps = defaultDeps,
): Promise<QualityRollupResult> => {
  const destinations = deps.activeDestinations();
  const generatedAt = new Date();
  const maxScopes = config.daemon.memory_quality_rollups_max_scopes_per_run ?? 100;
  let factsSeen = 0;
  let eventsSeen = 0;
  let rollupsUpserted = 0;
  let scopesCapped = false;

  for (const destination of destinations) {
    const { facts, events } = await fetchQualityInputs(deps, destination);
    factsSeen += facts.length;
    eventsSeen += events.length;
    const rollups = buildQualityRollups({
      facts,
      events,
      generatedAt,
      staleThresholdDays: config.daemon.staleness_threshold_days,
      lowConfidenceThreshold: config.daemon.memory_quality_rollups_low_confidence_threshold,
    });
    const selectedRollups = rollups.slice(0, maxScopes);
    scopesCapped ||= rollups.length > selectedRollups.length;
    for (const rollup of selectedRollups) {
      await upsertRollup(deps, destination, rollup);
      rollupsUpserted++;
    }
  }

  return {
    destinations_seen: destinations.length,
    facts_seen: factsSeen,
    events_seen: eventsSeen,
    rollups_upserted: rollupsUpserted,
    scopes_capped: scopesCapped,
  };
};

export const tick = async (
  config: BikkyConfig,
  deps: QualityRollupDeps = defaultDeps,
): Promise<void> => {
  if (!config.daemon.memory_quality_rollups_enabled) return;
  if (!deps.isReady()) return;

  const now = new Date();
  const nowIso = now.toISOString();
  const state = readMaintenanceState(logFn);
  const job = state.jobs.memory_quality_rollups;
  const intervalSec = config.daemon.memory_quality_rollups_interval_sec ?? 3600;
  if (!shouldRunMaintenance(now, job.last_run_at, intervalSec)) return;

  try {
    const result = await aggregateMemoryQualitySignals(config, deps);
    recordMaintenanceRun(JOB_NAME, {
      job: JOB_NAME,
      ran_at: nowIso,
      status: result.facts_seen === 0 ? "skipped" : "success",
      candidates_seen: result.facts_seen + result.events_seen,
      llm_calls: 0,
      accepted: result.rollups_upserted,
      deterministic: result.rollups_upserted,
      skipped_reason: result.facts_seen === 0
        ? "no_active_facts"
        : result.scopes_capped
          ? "max_scopes_per_run_reached"
          : undefined,
    }, { cursorUpdatedAt: nowIso }, logFn);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logFn("ERROR", `Memory quality rollups failed: ${message}`);
    recordMaintenanceRun(JOB_NAME, {
      job: JOB_NAME,
      ran_at: nowIso,
      status: "error",
      candidates_seen: 0,
      llm_calls: 0,
      accepted: 0,
      error: message,
    }, {}, logFn);
  }
};
