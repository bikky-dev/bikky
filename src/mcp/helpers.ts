/**
 * Pure helper functions for the Memory MCP server.
 *
 * Every function here is pure (or depends only on its inputs + Date.now()).
 */

import crypto from "node:crypto";
import type { FactPayload, FilterParams, QdrantFilter, QdrantPoint } from "./types.js";
import { DECAY_HALF_LIFE, DECAY_DEFAULT_HALF_LIFE, STALENESS_DAYS } from "./taxonomy.js";

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
 * Compute effective confidence using exponential decay.
 * Categories with null half-life (session_summary, distilled) don't decay.
 */
export function computeEffectiveConfidence(payload: FactPayload): number {
  const cat = payload.category;
  const halfLife = cat in DECAY_HALF_LIFE ? DECAY_HALF_LIFE[cat] : DECAY_DEFAULT_HALF_LIFE;
  if (halfLife === null || halfLife === undefined) return payload.confidence;
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

/** Build a Qdrant filter object from optional params. */
export function buildFilter(params: FilterParams = {}): QdrantFilter | undefined {
  const { category, domain, kind, entity, since, until, excludeSuperseded = true, metadata } = params;
  const must: QdrantFilter["must"] = [];

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
  if (entity) {
    must.push({ key: "entities", match: { value: entity.toLowerCase() } });
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
  return must.length > 0 ? { must } : undefined;
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

  if (p.domain && p.domain !== "work") parts.push(`domain: ${p.domain}`);
  if (p.kind && p.kind !== "fact") parts.push(`kind: ${p.kind}`);
  if (p.entities?.length) parts.push(`entities: ${p.entities.join(", ")}`);
  if (effectiveConf < p.confidence) {
    parts.push(`confidence: ${p.confidence} → effective: ${effectiveConf}`);
  } else {
    parts.push(`confidence: ${p.confidence}`);
  }
  if (p.reinforcement_count > 1) parts.push(`reinforced: ${p.reinforcement_count}x`);
  if ((p.verification_count ?? 0) > 0) parts.push(`verified: ${p.verification_count}x`);
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
