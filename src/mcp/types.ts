/**
 * Type definitions for the Memory MCP server.
 */

import type { OperationOrigin } from "../provenance/origin.js";

// ---------------------------------------------------------------------------
// MCP SDK result type
// ---------------------------------------------------------------------------

export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Taxonomy types
// ---------------------------------------------------------------------------

export interface CategoryDef {
  description: string;
  examples: string[];
}

export interface AxisDef {
  description: string;
}

// ---------------------------------------------------------------------------
// Qdrant types
// ---------------------------------------------------------------------------

export interface QdrantIndex {
  field_name: string;
  field_schema: string;
}

export interface QdrantFilterCondition {
  key?: string;
  match?: { value?: string | number; any?: string[] };
  range?: { gte?: string; lte?: string };
  is_null?: { key: string };
  is_empty?: { key: string };
  must?: QdrantFilterCondition[];
  should?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}

export interface QdrantFilter {
  must: QdrantFilterCondition[];
  should?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}

export interface QdrantPoint {
  id: string;
  score?: number;
  payload: FactPayload;
  _combinedScore?: number;
}

export interface QdrantScrollResult {
  result: {
    points: QdrantPoint[];
    next_page_offset?: string | null;
  };
}

export interface QdrantSearchResult {
  result: QdrantPoint[];
}

export interface QdrantGetResult {
  result: QdrantPoint[];
}

// ---------------------------------------------------------------------------
// Fact payload (what's stored in Qdrant)
// workspace_id removed in v0.4.0 — existing payloads may still carry it but
// it is no longer indexed or filtered. Use destinations for physical separation.
// ---------------------------------------------------------------------------

export interface FactPayload {
  content: string;
  category: string;
  domain?: string;
  kind?: string;
  layer?: string | null;
  memory_subtype?: string | null;
  origin?: OperationOrigin;
  last_operation_origin?: OperationOrigin;
  /** @deprecated Origin is canonical for new writes. */
  actor_id?: string;
  entities: string[];
  /** @deprecated Origin is canonical for new writes. */
  source?: string;
  confidence: number;
  importance?: number;
  content_hash: string;
  reinforcement_count: number;
  last_reinforced_at: string;
  last_verified_at?: string;
  verification_count?: number;
  useful_count?: number;
  not_useful_count?: number;
  last_used_at?: string;
  last_feedback_at?: string;
  superseded_by: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, string | number | boolean | null>;
  episode_id?: string | null;
  workstream_key?: string | null;
  task_key?: string | null;
  repo?: string | null;
  branch?: string | null;
  surface?: string | null;
  issue_id?: string | null;
  pr_id?: string | null;
  source_event_ids?: string[];
  source_fact_ids?: string[];
  source_episode_ids?: string[];
  prompt_version?: string | null;
  capture_policy_version?: string | null;
  review_status?: string | null;
  volatility?: string | null;
  valid_from?: string | null;
  expires_at?: string | null;
  quality_score?: number | null;
  confidence_reason?: string | null;
  owner_scope?: string | null;
  visibility?: string | null;
  audience?: string | null;
  sensitivity?: string | null;
  redaction?: {
    redacted: boolean;
    summary: string;
    matches: Array<{ type: string; count: number }>;
  };

  // Relation fields
  from_entity?: string;
  relation_type?: string;
  to_entity?: string;

  // Session summary fields
  session_id?: string;
  tasks_completed?: string[];
  decisions_made?: string[];

  // Distillation fields
  distilled_from?: string[];
  distilled_period_start?: string;
  distilled_period_end?: string;
  summary_count?: number;

  // Telemetry fields
  telemetry_type?: string;
  event_session_id?: string;
  recall_query?: string;
  returned_fact_ids?: string[];
  feedback_note?: string;
  outcome?: string;
  outcome_summary?: string;
}

// ---------------------------------------------------------------------------
// Filter builder params
// ---------------------------------------------------------------------------

export interface FilterParams {
  category?: string;
  domain?: string;
  kind?: string;
  memory_subtype?: string;
  origin_user_id?: string;
  origin_agent_id?: string;
  origin_interface?: string;
  /** @deprecated Use origin_user_id / origin_agent_id. */
  actor_id?: string;
  entity?: string;
  session_id?: string;
  episode_id?: string;
  workstream_key?: string;
  task_key?: string;
  repo?: string;
  branch?: string;
  review_status?: string;
  since?: string;
  until?: string;
  excludeSuperseded?: boolean;
  excludeKinds?: string[];
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Similar / conflict result shapes
// ---------------------------------------------------------------------------

export interface SimilarFact {
  id: string;
  content: string;
  score: number;
}

export interface PotentialConflict {
  id: string;
  content: string;
  category: string;
  similarity: number;
  shared_entities: string[];
}
