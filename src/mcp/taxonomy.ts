/**
 * Memory Taxonomy — Single source of truth for all classification axes.
 *
 * Four orthogonal axes classify every fact:
 *   category — topic/subject matter (what the fact is about)
 *   domain   — life scope (work vs personal context)
 *   kind     — epistemic type (how the knowledge exists)
 *   source   — provenance (who/what created this fact)
 */

import type { AxisDef, CategoryDef, QdrantIndex } from "./types.js";

// ─── Category: topic/subject matter ─────────────────────────────────────────

export const CATEGORIES: Record<string, CategoryDef> = {
  infrastructure: {
    description: "Services, ports, configs, databases, deployments, environments",
    extractionHint:
      "Look for: service names, ports, hosts, connection strings, database engines, cluster details, deployment targets, environment variables, config values",
    examples: [
      { content: "ClickHouse runs on port 8123 in production clusters", entities: ["clickhouse"], confidence: 0.95, importance: 0.8 },
      { content: "The dbt project uses ReplacingMergeTree engine for dedup tables", entities: ["dbt", "clickhouse"], confidence: 0.9, importance: 0.7 },
      { content: "Redis cache is on redis-prod.internal:6379 with 30-min TTL", entities: ["redis"], confidence: 0.9, importance: 0.8 },
    ],
  },
  decisions: {
    description: "Architectural decisions, technology choices, trade-offs, with who decided and why",
    extractionHint:
      "Look for: 'decided', 'chose', 'went with', 'instead of', 'because', trade-off discussions, architecture choices, technology selections",
    examples: [
      { content: "Team decided to use JWT for service-to-service auth instead of mTLS", entities: ["auth", "jwt"], confidence: 0.9, importance: 0.85 },
      { content: "Saber chose Qdrant over Pinecone for vector storage due to self-hosting option", entities: ["saber", "qdrant", "pinecone"], confidence: 0.95, importance: 0.8 },
    ],
  },
  observation: {
    description: "Errors encountered, quirks, workarounds, debugging findings, gotchas, behavioral patterns",
    extractionHint:
      "Look for: error messages, debugging steps, 'turns out', 'the issue was', workarounds, unexpected behavior, gotchas, caveats",
    examples: [
      { content: "ClickHouse OPTIMIZE FINAL is slow on large tables — use OPTIMIZE DEDUPLICATE instead", entities: ["clickhouse"], confidence: 0.9, importance: 0.7 },
      { content: "Node 25 fetch() doesn't support AbortSignal.timeout() in some edge cases", entities: ["node"], confidence: 0.7, importance: 0.5 },
    ],
  },
  preferences: {
    description: "User/team preferences, working style, conventions, opinions, personal tastes",
    extractionHint:
      "Look for: 'prefer', 'like', 'want', 'always use', conventions, style guides, opinions, personal choices, hobbies, interests",
    examples: [
      { content: "Saber prefers dark mode and concise responses under 3 sentences", entities: ["saber"], confidence: 0.85, importance: 0.3 },
      { content: "Code style: kebab-case for file names, camelCase for JS variables", entities: [], confidence: 0.8, importance: 0.4 },
    ],
  },
  projects: {
    description: "What's in progress, blocked, completed, project structure, goals, personal endeavors",
    extractionHint:
      "Look for: task progress, blockers, completions, branch names, deployment status, milestones, goals, project structure, hobbies, personal projects",
    examples: [
      { content: "The agent00 cortex memory extraction pipeline is being built", entities: ["agent00", "cortex"], confidence: 0.95, importance: 0.6 },
      { content: "Saber is growing tomatoes and herbs in the backyard garden", entities: ["saber", "garden"], confidence: 0.85, importance: 0.4 },
    ],
  },
  team: {
    description: "People, roles, relationships, organizational structure, contacts",
    extractionHint:
      "Look for: names, titles, roles, reporting lines, team membership, expertise areas, contact details, who owns what",
    examples: [
      { content: "Saber is the founder and primary developer of agent00", entities: ["saber", "agent00"], confidence: 0.95, importance: 0.7 },
      { content: "Alex handles DevOps and Kubernetes cluster management", entities: ["alex", "devops", "kubernetes"], confidence: 0.9, importance: 0.6 },
    ],
  },
};

// ─── Domain: life scope ─────────────────────────────────────────────────────

export const DOMAINS: Record<string, AxisDef> = {
  work: { description: "Engineering, company, professional context" },
  personal: { description: "Life, hobbies, health, family, personal projects" },
};

export const DEFAULT_DOMAIN = "work";

// ─── Kind: epistemic type ───────────────────────────────────────────────────

export const KINDS: Record<string, AxisDef> = {
  fact: { description: "Atomic declarative assertion — the default" },
  summary: { description: "Compressed narrative of a session or time period" },
  distilled: { description: "Second-order pattern derived from multiple summaries" },
  relation: { description: "Typed edge between two entities (from → type → to)" },
};

export const DEFAULT_KIND = "fact";

// ─── Source: provenance ─────────────────────────────────────────────────────

export const SOURCES: Record<string, AxisDef> = {
  agent: { description: "Stored by an agent via MCP memory_store tool" },
  cortex: { description: "Extracted by the background cortex pipeline" },
  system: { description: "Generated by system processes (distillation, session summaries)" },
  user: { description: "Explicitly requested by the user (manual corrections, direct input)" },
  docs: { description: "Indexed from documentation (knowledge base)" },
};

export const DEFAULT_SOURCE = "agent";

// ─── Decay configuration ────────────────────────────────────────────────────

const FACT_DECAY: Record<string, number> = {
  "observation.work": 45,
  "observation.personal": 180,
  "infrastructure.work": 60,
  "infrastructure.personal": 180,
  "decisions.*": 120,
  "preferences.*": 365,
  "projects.work": 90,
  "projects.personal": 180,
  "team.*": 365,
};

export const DECAY_DEFAULT_HALF_LIFE = 90;

export function getDecayHalfLife(opts: { kind?: string; category?: string; domain?: string } = {}): number | null {
  const { kind, category, domain } = opts;

  if (kind === "summary" || kind === "distilled") return null;
  if (kind === "relation") return 180;

  const key = `${category ?? "observation"}.${domain ?? DEFAULT_DOMAIN}`;
  const keyVal = FACT_DECAY[key];
  if (keyVal !== undefined) return keyVal;

  const catKey = `${category ?? "observation"}.*`;
  const catVal = FACT_DECAY[catKey];
  if (catVal !== undefined) return catVal;

  return DECAY_DEFAULT_HALF_LIFE;
}

// Legacy flat map for old code paths
export const DECAY_HALF_LIFE: Record<string, number | null> = {
  infrastructure: 60,
  projects: 90,
  decisions: 120,
  observation: 45,
  personal: 365,
  preferences: 365,
  team: 365,
  relation: 180,
  session_summary: null,
  distilled: null,
};

// ─── Staleness ──────────────────────────────────────────────────────────────

export const STALENESS_DAYS = 30;

// ─── Similarity thresholds ──────────────────────────────────────────────────

export const THRESHOLD_DUPLICATE = 0.92;
export const THRESHOLD_RELATED = 0.80;

// ─── Qdrant indexes ────────────────────────────────────────────────────────

export const QDRANT_INDEXES: QdrantIndex[] = [
  { field_name: "category", field_schema: "keyword" },
  { field_name: "domain", field_schema: "keyword" },
  { field_name: "kind", field_schema: "keyword" },
  { field_name: "source", field_schema: "keyword" },
  { field_name: "entities", field_schema: "keyword" },
  { field_name: "content_hash", field_schema: "keyword" },
  { field_name: "from_entity", field_schema: "keyword" },
  { field_name: "to_entity", field_schema: "keyword" },
  { field_name: "relation_type", field_schema: "keyword" },
  { field_name: "superseded_by", field_schema: "keyword" },
  { field_name: "session_id", field_schema: "keyword" },
  { field_name: "last_reinforced_at", field_schema: "datetime" },
  { field_name: "last_verified_at", field_schema: "datetime" },
];

// ─── Source value migration (old → new) ─────────────────────────────────────

export const SOURCE_MIGRATION: Record<string, string> = {
  conversation: "agent",
  task: "agent",
  observation: "agent",
  manual: "user",
  cortex: "cortex",
};

// ─── Normalization helpers ──────────────────────────────────────────────────

export function normalizeCategory(cat: string): string {
  const lower = String(cat).toLowerCase().trim();
  if (lower in CATEGORIES) return lower;
  if (lower === "personal") return "preferences";
  if (lower === "session_summary") return "projects";
  if (lower === "distilled") return "observation";
  if (lower === "relation") return "team";
  if (lower.includes("infra")) return "infrastructure";
  if (lower.includes("decision")) return "decisions";
  if (lower.includes("observ") || lower.includes("error")) return "observation";
  if (lower.includes("prefer")) return "preferences";
  if (lower.includes("project")) return "projects";
  if (lower.includes("team") || lower.includes("people")) return "team";
  return "observation";
}

export function normalizeDomain(d: string | undefined): string {
  if (!d) return DEFAULT_DOMAIN;
  const lower = String(d).toLowerCase().trim();
  if (lower in DOMAINS) return lower;
  if (lower.includes("personal") || lower.includes("life") || lower.includes("home")) return "personal";
  return DEFAULT_DOMAIN;
}

export function normalizeKind(k: string | undefined): string {
  if (!k) return DEFAULT_KIND;
  const lower = String(k).toLowerCase().trim();
  if (lower in KINDS) return lower;
  if (lower.includes("summar")) return "summary";
  if (lower.includes("distil")) return "distilled";
  if (lower.includes("relat") || lower.includes("edge")) return "relation";
  return DEFAULT_KIND;
}

export function normalizeSource(s: string | undefined): string {
  if (!s) return DEFAULT_SOURCE;
  const lower = String(s).toLowerCase().trim();
  if (lower in SOURCES) return lower;
  const migrated = SOURCE_MIGRATION[lower];
  if (migrated) return migrated;
  return DEFAULT_SOURCE;
}

// ─── Value arrays for z.enum consumption ────────────────────────────────────

export const categoryValues = (): [string, ...string[]] =>
  Object.keys(CATEGORIES) as [string, ...string[]];

export const domainValues = (): [string, ...string[]] =>
  Object.keys(DOMAINS) as [string, ...string[]];

export const kindValues = (): [string, ...string[]] =>
  Object.keys(KINDS) as [string, ...string[]];

export const sourceValues = (): [string, ...string[]] =>
  Object.keys(SOURCES) as [string, ...string[]];
