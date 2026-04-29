/**
 * Pure helper functions for the Memory MCP server.
 *
 * Every function here is pure (or depends only on its inputs + Date.now()).
 */

import crypto from "node:crypto";
import type { FactPayload, FilterParams, QdrantFilter, QdrantPoint } from "./types.js";
import { DEFAULT_DOMAIN, getDecayHalfLife, STALENESS_DAYS } from "./taxonomy.js";

export interface StructuredFact {
  id: string;
  content: string;
  category: string;
  domain?: string;
  kind?: string;
  memory_subtype?: string | null;
  workspace_id?: string;
  source?: string;
  entities: string[];
  confidence?: number;
  effective_confidence?: number;
  importance?: number;
  reinforcement_count?: number;
  verification_count?: number;
  useful_count?: number;
  not_useful_count?: number;
  redaction?: FactPayload["redaction"];
  metadata?: FactPayload["metadata"];
  workstream_key?: string | null;
  episode_id?: string | null;
  task_key?: string | null;
  repo?: string | null;
  branch?: string | null;
  created_at?: string;
  updated_at?: string;
  last_activity_at?: string;
  stale: boolean;
  score?: number;
  rank?: number;
  relation?: {
    from_entity?: string;
    type?: string;
    to_entity?: string;
  };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function contentHash(category: string, content: string): string {
  const normalized = `${category}:${content.toLowerCase().trim().replace(/\s+/g, " ")}`;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Days between an ISO timestamp and now. Returns Infinity for null/undefined. */
export function daysSince(isoTimestamp: string | undefined | null): number {
  if (!isoTimestamp) return Infinity;
  return Math.max(0, (Date.now() - new Date(isoTimestamp).getTime()) / 86400000);
}

/** The most recent "activity" timestamp for a fact (verified > reinforced > created). */
export function lastActivityDate(payload: FactPayload): string | undefined {
  return payload.last_verified_at ?? payload.last_reinforced_at ?? payload.created_at;
}

// ---------------------------------------------------------------------------
// Scoring functions (all computed at read time, never mutate stored data)
// ---------------------------------------------------------------------------

/**
 * Multiplier on the per-category half-life when a fact carries a volatility
 * label. Transient/ephemeral facts decay much faster than the category default.
 * Stable/evolving (and undefined) leave the half-life unchanged.
 */
const VOLATILITY_HALF_LIFE_MULTIPLIER: Record<string, number> = {
  stable: 1.0,
  evolving: 1.0,
  transient: 0.25,
  ephemeral: 0.1,
};

/**
 * Compute effective confidence using exponential decay.
 * Categories with null half-life (session_summary, distilled) don't decay.
 */
export function computeEffectiveConfidence(payload: FactPayload): number {
  const baseHalfLife = getDecayHalfLife({
    category: payload.category,
    domain: payload.domain,
    kind: payload.kind,
  });
  if (baseHalfLife === null || baseHalfLife === undefined) return payload.confidence;
  const volatilityMultiplier =
    payload.volatility && VOLATILITY_HALF_LIFE_MULTIPLIER[payload.volatility] !== undefined
      ? VOLATILITY_HALF_LIFE_MULTIPLIER[payload.volatility]
      : 1.0;
  const halfLife = baseHalfLife * volatilityMultiplier;
  const days = daysSince(lastActivityDate(payload));
  const decayFactor = Math.pow(0.5, days / halfLife);
  return Math.round(payload.confidence * decayFactor * 100) / 100;
}

/**
 * Freshness score for recall re-ranking.
 * 1.0 for facts < 7 days old, linear decay to 0.3 at 180 days, floor at 0.3.
 */
export function computeFreshnessScore(payload: FactPayload): number {
  const days = daysSince(lastActivityDate(payload));
  if (days <= 7) return 1.0;
  if (days >= 180) return 0.3;
  return 1.0 - (days - 7) * (0.7 / 173);
}

/** Reinforcement score: min(reinforcement_count / 5, 1.0). */
export function computeReinforcementScore(payload: FactPayload): number {
  return Math.min((payload.reinforcement_count || 1) / 5, 1.0);
}

/**
 * Combined re-ranking score for recall results.
 * Blends vector similarity with freshness, reinforcement, importance, and confidence decay.
 */
export function computeCombinedScore(point: QdrantPoint): number {
  const vectorScore = point.score ?? 0;
  const freshness = computeFreshnessScore(point.payload);
  const reinforcement = computeReinforcementScore(point.payload);
  const importance = point.payload.importance ?? 0.5;
  const confidenceDecay = computeEffectiveConfidence(point.payload) / Math.max(point.payload.confidence, 0.01);
  return (vectorScore * 0.55 + freshness * 0.15 + reinforcement * 0.1 + importance * 0.1) * (0.7 + 0.3 * confidenceDecay);
}

/** Check if a fact is stale (old + not recently reinforced/verified). */
export function isStale(payload: FactPayload): boolean {
  return daysSince(lastActivityDate(payload)) > STALENESS_DAYS;
}

// ---------------------------------------------------------------------------
// Filter building
// ---------------------------------------------------------------------------

export const MEMORY_RECALL_EXCLUDED_KINDS = ["telemetry"];

/** Build a Qdrant filter object from optional params. */
export function buildFilter(params: FilterParams = {}): QdrantFilter | undefined {
  const {
    category,
    domain,
    kind,
    memory_subtype,
    workspace_id,
    includeLegacyWorkspace = false,
    actor_id,
    entity,
    session_id,
    episode_id,
    workstream_key,
    task_key,
    repo,
    branch,
    review_status,
    since,
    until,
    excludeSuperseded = true,
    excludeKinds = [],
    metadata,
  } = params;
  const must: QdrantFilter["must"] = [];
  const must_not: QdrantFilter["must_not"] = [];
  const should: QdrantFilter["should"] = [];

  if (excludeSuperseded) {
    must.push({ is_null: { key: "superseded_by" } });
  }
  if (category) {
    must.push({ key: "category", match: { value: category } });
  }
  if (domain) {
    must.push({ key: "domain", match: { value: domain } });
  }
  if (kind) {
    must.push({ key: "kind", match: { value: kind } });
  }
  if (memory_subtype) {
    must.push({ key: "memory_subtype", match: { value: memory_subtype } });
  }
  if (workspace_id) {
    if (includeLegacyWorkspace) {
      should.push(
        { key: "workspace_id", match: { value: workspace_id } },
        { is_empty: { key: "workspace_id" } },
      );
    } else {
      must.push({ key: "workspace_id", match: { value: workspace_id } });
    }
  }
  if (actor_id) {
    must.push({ key: "actor_id", match: { value: actor_id } });
  }
  if (entity) {
    must.push({ key: "entities", match: { value: entity.toLowerCase() } });
  }
  for (const [key, value] of Object.entries({
    session_id,
    episode_id,
    workstream_key,
    task_key,
    repo,
    branch,
    review_status,
  })) {
    if (value) {
      must.push({ key, match: { value } });
    }
  }
  if (since && until) {
    must.push({ key: "created_at", range: { gte: since, lte: until } });
  } else if (since) {
    must.push({ key: "created_at", range: { gte: since } });
  } else if (until) {
    must.push({ key: "created_at", range: { lte: until } });
  }
  if (metadata && typeof metadata === "object") {
    for (const [k, v] of Object.entries(metadata)) {
      must.push({ key: `metadata.${k}`, match: { value: v } });
    }
  }
  for (const excludedKind of excludeKinds) {
    must_not.push({ key: "kind", match: { value: excludedKind } });
  }

  if (must.length === 0 && should.length === 0 && must_not.length === 0) return undefined;
  return {
    must,
    ...(should.length > 0 ? { should } : {}),
    ...(must_not.length > 0 ? { must_not } : {}),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a Qdrant point into a human-readable fact string. */
export function formatFact(point: QdrantPoint): string {
  const p = point.payload;
  const effectiveConf = computeEffectiveConfidence(p);
  const stale = isStale(p);
  const parts: string[] = [`${stale ? "🕰️ " : ""}[${p.category}] ${p.content}`];

  if (p.domain && p.domain !== DEFAULT_DOMAIN) parts.push(`domain: ${p.domain}`);
  if (p.kind && p.kind !== "fact") parts.push(`kind: ${p.kind}`);
  if (p.memory_subtype) parts.push(`subtype: ${p.memory_subtype}`);
  if (p.workspace_id && p.workspace_id !== "default") parts.push(`workspace: ${p.workspace_id}`);
  if (p.workstream_key) parts.push(`workstream: ${p.workstream_key}`);
  if (p.episode_id) parts.push(`episode: ${p.episode_id}`);
  if (p.entities?.length) parts.push(`entities: ${p.entities.join(", ")}`);
  if (effectiveConf < p.confidence) {
    parts.push(`confidence: ${p.confidence} → effective: ${effectiveConf}`);
  } else {
    parts.push(`confidence: ${p.confidence}`);
  }
  if (p.reinforcement_count > 1) parts.push(`reinforced: ${p.reinforcement_count}x`);
  if ((p.verification_count ?? 0) > 0) parts.push(`verified: ${p.verification_count}x`);
  if ((p.useful_count ?? 0) > 0) parts.push(`useful: ${p.useful_count}x`);
  if ((p.not_useful_count ?? 0) > 0) parts.push(`not useful: ${p.not_useful_count}x`);
  if (p.redaction?.redacted) parts.push(`redacted: ${p.redaction.summary}`);
  if (p.metadata && Object.keys(p.metadata).length > 0) {
    const metaPairs = Object.entries(p.metadata).map(([k, v]) => `${k}=${v}`).join(", ");
    parts.push(`metadata: {${metaPairs}}`);
  }
  if (p.created_at) parts.push(`created: ${p.created_at}`);
  parts.push(`id: ${point.id}`);
  if (point.score !== undefined) parts.push(`score: ${point.score.toFixed(3)}`);
  if (point._combinedScore !== undefined) parts.push(`rank: ${point._combinedScore.toFixed(3)}`);
  return parts.join(" | ");
}

function roundMetric(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(value * 1000) / 1000;
}

/** Convert a Qdrant point into a stable structured object for agent parsing. */
export function structuredFact(point: QdrantPoint): StructuredFact {
  const p = point.payload;
  const confidence = typeof p.confidence === "number" ? p.confidence : undefined;
  const effectiveConfidence = confidence === undefined ? undefined : computeEffectiveConfidence(p);
  const relation =
    p.from_entity || p.relation_type || p.to_entity
      ? {
        ...(p.from_entity ? { from_entity: p.from_entity } : {}),
        ...(p.relation_type ? { type: p.relation_type } : {}),
        ...(p.to_entity ? { to_entity: p.to_entity } : {}),
      }
      : undefined;

  return {
    id: point.id,
    content: p.content,
    category: p.category,
    ...(p.domain ? { domain: p.domain } : {}),
    ...(p.kind ? { kind: p.kind } : {}),
    ...(p.memory_subtype ? { memory_subtype: p.memory_subtype } : {}),
    ...(p.workspace_id ? { workspace_id: p.workspace_id } : {}),
    ...(p.source ? { source: p.source } : {}),
    entities: p.entities ?? [],
    ...(confidence !== undefined ? { confidence } : {}),
    ...(effectiveConfidence !== undefined ? { effective_confidence: effectiveConfidence } : {}),
    ...(p.importance !== undefined ? { importance: p.importance } : {}),
    ...(p.reinforcement_count !== undefined ? { reinforcement_count: p.reinforcement_count } : {}),
    ...(p.verification_count !== undefined ? { verification_count: p.verification_count } : {}),
    ...(p.useful_count !== undefined ? { useful_count: p.useful_count } : {}),
    ...(p.not_useful_count !== undefined ? { not_useful_count: p.not_useful_count } : {}),
    ...(p.redaction ? { redaction: p.redaction } : {}),
    ...(p.metadata && Object.keys(p.metadata).length > 0 ? { metadata: p.metadata } : {}),
    ...(p.workstream_key ? { workstream_key: p.workstream_key } : {}),
    ...(p.episode_id ? { episode_id: p.episode_id } : {}),
    ...(p.task_key ? { task_key: p.task_key } : {}),
    ...(p.repo ? { repo: p.repo } : {}),
    ...(p.branch ? { branch: p.branch } : {}),
    ...(p.created_at ? { created_at: p.created_at } : {}),
    ...(p.updated_at ? { updated_at: p.updated_at } : {}),
    ...(lastActivityDate(p) ? { last_activity_at: lastActivityDate(p) } : {}),
    stale: isStale(p),
    ...(roundMetric(point.score) !== undefined ? { score: roundMetric(point.score) } : {}),
    ...(roundMetric(point._combinedScore) !== undefined ? { rank: roundMetric(point._combinedScore) } : {}),
    ...(relation ? { relation } : {}),
  };
}
