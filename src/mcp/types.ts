/**
 * Type definitions for the Memory MCP server.
 */

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
  extractionHint: string;
  examples: Array<{
    content: string;
    entities: string[];
    confidence: number;
    importance: number;
  }>;
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
// ---------------------------------------------------------------------------

export interface FactPayload {
  content: string;
  category: string;
  domain?: string;
  kind?: string;
  entities: string[];
  source?: string;
  confidence: number;
  importance?: number;
  content_hash: string;
  reinforcement_count: number;
  last_reinforced_at: string;
  last_verified_at?: string;
  verification_count?: number;
  superseded_by: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, string>;

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
}

// ---------------------------------------------------------------------------
// Filter builder params
// ---------------------------------------------------------------------------

export interface FilterParams {
  category?: string;
  domain?: string;
  kind?: string;
  entity?: string;
  since?: string;
  until?: string;
  excludeSuperseded?: boolean;
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
