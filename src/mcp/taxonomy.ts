/**
 * Bikky memory ontology.
 *
 * The memory ontology separates ownership boundaries from semantic meaning:
 * workspace -> domain -> repo/project/surface -> workstream -> episode -> memory objects.
 */

// ---------------------------------------------------------------------------
// Categories: subject matter
// ---------------------------------------------------------------------------

export const CATEGORIES = {
  engineering: {
    description:
      "Engineering context: codebase maps, architecture decisions, infrastructure topology, access patterns, operations, troubleshooting, and reusable conventions.",
    examples: [
      "The auth middleware lives in src/server/auth.ts.",
      "If Qdrant order_by fails, create the payload index before retrying.",
    ],
  },
  product: {
    description:
      "Product context: domain rules, product decisions, requirements, user workflows, roadmap, success metrics, and market or community insight.",
    examples: [
      "Bikky should show categories and concrete subtype chips directly, with no extra sub-tab layer.",
      "Activation should be measured by whether agents successfully reuse recalled memory.",
    ],
  },
  human: {
    description:
      "Human context: explicit preferences, people and roles, ownership, working agreements, and durable actor-action activity events.",
    examples: [
      "Saber prefers concise implementation plans before code changes.",
      "Alex approved PR #85 for merge.",
    ],
  },
  system: {
    description:
      "System context: Bikky-owned lifecycle memory, session indexes, episodes, workstreams, recall/feedback/outcome telemetry, and aggregate rollups.",
    examples: [
      "Session indexes are routing/audit artifacts rather than durable project boundaries.",
      "Recall telemetry is excluded from normal semantic recall.",
    ],
  },
} as const;

export type Category = keyof typeof CATEGORIES;

export const DEFAULT_CATEGORY: Category = "engineering";

// ---------------------------------------------------------------------------
// Domains: activity / knowledge profiles
// ---------------------------------------------------------------------------

export const DOMAINS = {
  software_engineering: {
    description:
      "Coding-agent work: repositories, code changes, architecture, infrastructure, debugging, tests, CI, and developer workflow.",
    defaultCategories: [
      "engineering",
      "product",
      "human",
      "system",
    ] as const,
  },
  product_strategy: {
    description:
      "Product direction, positioning, roadmap tradeoffs, customer problems, metrics, and market learning.",
    defaultCategories: [
      "product",
      "human",
      "system",
    ] as const,
  },
  business_operations: {
    description:
      "Business process, vendors, finance, legal/admin operations, recurring procedures, and ownership.",
    defaultCategories: [
      "product",
      "human",
      "system",
    ] as const,
  },
  research: {
    description:
      "Research questions, sources, hypotheses, experiment findings, synthesis, and reusable insights.",
    defaultCategories: [
      "product",
      "engineering",
      "system",
    ] as const,
  },
  personal_productivity: {
    description:
      "Individual productivity, habits, planning preferences, reminders, and personal operating context.",
    defaultCategories: [
      "human",
      "product",
      "system",
    ] as const,
  },
} as const;

export type Domain = keyof typeof DOMAINS;

export const DEFAULT_DOMAIN: Domain = "software_engineering";

// ---------------------------------------------------------------------------
// Layers: hierarchy placement
// ---------------------------------------------------------------------------

export const LAYERS = {
  workspace: {
    description: "Ownership, tenancy, access policy, sharing, redaction, retention, and quotas.",
  },
  domain: {
    description: "Semantic profile that controls vocabulary, prompts, categories, ranking, and capture policy.",
  },
  surface: {
    description: "Concrete operating surface such as a repo, project, package, service, branch, or channel.",
  },
  workstream: {
    description: "Primary durable continuity key for a long-running objective or task.",
  },
  episode: {
    description: "Coherent segment of activity within a session or transcript.",
  },
  memory_object: {
    description: "A fact, summary, distilled learning, relation, or telemetry object.",
  },
} as const;

export type Layer = keyof typeof LAYERS;

// ---------------------------------------------------------------------------
// Kinds and subtypes: object shape
// ---------------------------------------------------------------------------

export const KINDS = {
  fact: {
    description: "Atomic, durable memory that should be retrievable independently.",
    examples: [
      "The daemon stores extracted coding-agent observations in Qdrant.",
      "The UI package uses Vite and Node's built-in test runner.",
    ],
  },
  summary: {
    description:
      "Compressed representation of a session index, coherent episode, or current workstream state.",
    examples: [
      "Episode summary of a coherent implementation task.",
      "Current-state summary for a workstream.",
    ],
  },
  distilled: {
    description:
      "Convention or reusable learning synthesized from multiple memories.",
    examples: [
      "Prefer explicit workspace filters for scoped team memory.",
      "Always create the relevant Qdrant payload index before adding a new filter.",
    ],
  },
  relation: {
    description: "Typed edge between entities; relation_type carries the edge label.",
    examples: [
      "bikky -> uses -> qdrant",
      "workspace_id -> represents -> access boundary",
    ],
  },
  telemetry: {
    description:
      "Memory-use, feedback, or outcome metadata used for product quality and operations; excluded from normal semantic recall.",
    examples: [
      "A recall event returned three facts for session abc.",
      "A user marked a fact useful.",
    ],
  },
} as const;

export type Kind = keyof typeof KINDS;

export const MEMORY_SUBTYPES = {
  fact: [
    "codebase_map",
    "architecture_decision",
    "infra_topology",
    "access_pattern",
    "operational_procedure",
    "domain_rule",
    "product_decision",
    "product_requirement",
    "user_workflow",
    "roadmap_item",
    "success_metric",
    "market_insight",
    "troubleshooting_gotcha",
    "preference",
    "person_profile",
    "ownership_note",
    "working_agreement",
    "activity_event",
  ],
  summary: ["session_index", "episode", "workstream"],
  distilled: ["convention"],
  relation: [],
  telemetry: ["recall_event", "feedback_event", "outcome_event", "aggregate_rollup"],
} as const satisfies Record<Kind, readonly string[]>;

export type MemorySubtype = (typeof MEMORY_SUBTYPES)[Kind][number];

export const DEFAULT_MEMORY_SUBTYPE_BY_KIND = {
  fact: "codebase_map",
  summary: "episode",
  distilled: "convention",
  relation: null,
  telemetry: "recall_event",
} as const satisfies Record<Kind, MemorySubtype | null>;

export const MEMORY_SUBTYPE_DEFAULT_CATEGORY = {
  codebase_map: "engineering",
  architecture_decision: "engineering",
  infra_topology: "engineering",
  access_pattern: "engineering",
  operational_procedure: "engineering",
  domain_rule: "product",
  product_decision: "product",
  product_requirement: "product",
  user_workflow: "product",
  roadmap_item: "product",
  success_metric: "product",
  market_insight: "product",
  troubleshooting_gotcha: "engineering",
  preference: "human",
  person_profile: "human",
  ownership_note: "human",
  working_agreement: "human",
  activity_event: "human",
  session_index: "system",
  episode: "system",
  workstream: "system",
  convention: "engineering",
  recall_event: "system",
  feedback_event: "system",
  outcome_event: "system",
  aggregate_rollup: "system",
} as const satisfies Record<MemorySubtype, Category>;

export const MEMORY_SUBTYPE_DEFAULT_LAYER = {
  codebase_map: "surface",
  architecture_decision: "surface",
  infra_topology: "surface",
  access_pattern: "surface",
  operational_procedure: "surface",
  domain_rule: "domain",
  product_decision: "domain",
  product_requirement: "domain",
  user_workflow: "domain",
  roadmap_item: "workstream",
  success_metric: "domain",
  market_insight: "domain",
  troubleshooting_gotcha: "surface",
  preference: "domain",
  person_profile: "domain",
  ownership_note: "domain",
  working_agreement: "domain",
  activity_event: "episode",
  session_index: "episode",
  episode: "episode",
  workstream: "workstream",
  convention: "domain",
  recall_event: "memory_object",
  feedback_event: "memory_object",
  outcome_event: "memory_object",
  aggregate_rollup: "workspace",
} as const satisfies Record<MemorySubtype, Layer>;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const SOURCES = {
  agent: {
    description: "Captured from an interactive agent tool call.",
  },
  system: {
    description:
      "Generated automatically by Bikky itself, including daemon capture, summaries, maintenance, migrations, and lifecycle code.",
  },
  user: {
    description: "Created or corrected directly by a user.",
  },
  docs: {
    description: "Imported from documentation or explicit source material.",
  },
} as const;

export type Source = keyof typeof SOURCES;

export const DEFAULT_KIND: Kind = "fact";
export const DEFAULT_SOURCE: Source = "agent";
export const STALENESS_DAYS = 30;
export const DECAY_DEFAULT_HALF_LIFE = 90;
export const THRESHOLD_DUPLICATE = 0.92;
export const THRESHOLD_RELATED = 0.8;

// ---------------------------------------------------------------------------
// Decay policy: half-life in days by category + domain profile
// ---------------------------------------------------------------------------

export const DECAY_HALF_LIFE: Record<string, number> = {
  // Software-engineering defaults.
  "engineering.software_engineering": 120,
  "product.software_engineering": 120,
  "human.software_engineering": 180,
  "system.software_engineering": 45,

  // Other domain profiles.
  "product.product_strategy": 180,
  "human.product_strategy": 180,
  "system.product_strategy": 60,
  "product.business_operations": 120,
  "human.business_operations": 180,
  "system.business_operations": 90,
  "product.research": 120,
  "engineering.research": 120,
  "system.research": 90,
  "human.personal_productivity": 180,
  "product.personal_productivity": 90,
  "system.personal_productivity": 45,

};

// ---------------------------------------------------------------------------
// Qdrant payload indexes
// ---------------------------------------------------------------------------

export const QDRANT_INDEXES: Array<{ field_name: string; field_schema: string }> = [
  { field_name: "category", field_schema: "keyword" },
  { field_name: "domain", field_schema: "keyword" },
  { field_name: "kind", field_schema: "keyword" },
  { field_name: "memory_subtype", field_schema: "keyword" },
  { field_name: "content_hash", field_schema: "keyword" },
  { field_name: "entities", field_schema: "keyword" },
  { field_name: "workspace_id", field_schema: "keyword" },
  // Deprecated legacy provenance fields remain indexed for fresh collections
  // that still need to browse/filter records written before origin metadata.
  { field_name: "source", field_schema: "keyword" },
  { field_name: "actor_id", field_schema: "keyword" },
  { field_name: "origin.user.id", field_schema: "keyword" },
  { field_name: "origin.user.source", field_schema: "keyword" },
  { field_name: "origin.agent.id", field_schema: "keyword" },
  { field_name: "origin.agent.type", field_schema: "keyword" },
  { field_name: "origin.agent.source", field_schema: "keyword" },
  { field_name: "origin.interface", field_schema: "keyword" },
  { field_name: "origin.operation.action", field_schema: "keyword" },
  { field_name: "last_operation_origin.agent.id", field_schema: "keyword" },
  { field_name: "last_operation_origin.operation.action", field_schema: "keyword" },
  { field_name: "entity_name", field_schema: "keyword" },
  { field_name: "from_entity", field_schema: "keyword" },
  { field_name: "to_entity", field_schema: "keyword" },
  { field_name: "relation_type", field_schema: "keyword" },
  { field_name: "review_status", field_schema: "keyword" },
  { field_name: "created_at", field_schema: "datetime" },
  { field_name: "updated_at", field_schema: "datetime" },
  { field_name: "last_seen_at", field_schema: "datetime" },
  { field_name: "last_reinforced_at", field_schema: "datetime" },
  { field_name: "last_verified_at", field_schema: "datetime" },
  { field_name: "stale_after", field_schema: "datetime" },
  { field_name: "session_id", field_schema: "keyword" },
  { field_name: "episode_id", field_schema: "keyword" },
  { field_name: "workstream_key", field_schema: "keyword" },
  { field_name: "task_key", field_schema: "keyword" },
  { field_name: "repo", field_schema: "keyword" },
  { field_name: "branch", field_schema: "keyword" },
  { field_name: "reviewed", field_schema: "bool" },
  { field_name: "verified", field_schema: "bool" },
  { field_name: "superseded", field_schema: "bool" },
  { field_name: "superseded_by", field_schema: "keyword" },
  { field_name: "is_bad_exemplar", field_schema: "bool" },
  { field_name: "useful_feedback_count", field_schema: "integer" },
  { field_name: "not_useful_feedback_count", field_schema: "integer" },
  { field_name: "recall_count", field_schema: "integer" },
  { field_name: "last_recalled_at", field_schema: "datetime" },
];

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

type NonEmptyStringArray = [string, ...string[]];

function normalizeToken(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function normalizeCategory(category: string | null | undefined): Category {
  const normalized = normalizeToken(category);
  if (normalized in CATEGORIES) {
    return normalized as Category;
  }
  if (
    normalized.includes("product") ||
    normalized.includes("domain") ||
    normalized.includes("roadmap") ||
    normalized.includes("requirement") ||
    normalized.includes("workflow") ||
    normalized.includes("metric") ||
    normalized.includes("market") ||
    normalized.includes("customer") ||
    normalized === "projects"
  ) return "product";
  if (
    normalized.includes("human") ||
    normalized.includes("people") ||
    normalized.includes("person") ||
    normalized.includes("owner") ||
    normalized.includes("team") ||
    normalized.includes("preference") ||
    normalized.includes("agreement") ||
    normalized.includes("activity") ||
    normalized.includes("actor")
  ) return "human";
  if (
    normalized.includes("system") ||
    normalized.includes("session") ||
    normalized.includes("episode") ||
    normalized.includes("workstream") ||
    normalized.includes("telemetry") ||
    normalized.includes("feedback") ||
    normalized.includes("outcome") ||
    normalized.includes("rollup")
  ) return "system";
  if (
    normalized.includes("infra") ||
    normalized.includes("decision") ||
    normalized.includes("operation") ||
    normalized.includes("runbook") ||
    normalized.includes("repo") ||
    normalized.includes("code") ||
    normalized.includes("architecture") ||
    normalized.includes("troubleshoot") ||
    normalized.includes("observation")
  ) return "engineering";
  return DEFAULT_CATEGORY;
}

export function normalizeDomain(domain: string | null | undefined): Domain {
  const normalized = normalizeToken(domain);
  if (normalized in DOMAINS) {
    return normalized as Domain;
  }
  return DEFAULT_DOMAIN;
}

export function normalizeKind(kind: string | null | undefined): Kind {
  const normalized = normalizeToken(kind);
  if (normalized in KINDS) {
    return normalized as Kind;
  }
  if (normalized.includes("summar")) return "summary";
  if (normalized.includes("distill")) return "distilled";
  if (normalized.includes("relation") || normalized.includes("edge")) return "relation";
  if (normalized.includes("telemetry") || normalized.includes("feedback_event")) return "telemetry";
  return "fact";
}

export function normalizeSource(source: string | null | undefined): Source {
  const normalized = normalizeToken(source);
  if (normalized === "daemon") return "system";
  if (normalized === "ui" || normalized === "portal") return "user";
  if (normalized === "cortex") return "agent";
  if (normalized in SOURCES) {
    return normalized as Source;
  }
  return DEFAULT_SOURCE;
}

export function normalizeLayer(layer: string | null | undefined): Layer | null {
  const normalized = normalizeToken(layer);
  if (normalized in LAYERS) {
    return normalized as Layer;
  }
  return null;
}

export function normalizeMemorySubtype(
  kind: string | null | undefined,
  subtype: string | null | undefined,
): MemorySubtype | null {
  const normalizedKind = normalizeKind(kind);
  const normalizedSubtype = normalizeToken(subtype);
  if (!normalizedSubtype) return null;

  const allowed = MEMORY_SUBTYPES[normalizedKind] as readonly string[];
  if (allowed.includes(normalizedSubtype)) {
    return normalizedSubtype as MemorySubtype;
  }
  return null;
}

export function validateMemorySubtype(
  kind: string | null | undefined,
  subtype: string | null | undefined,
): MemorySubtype | null {
  if (!subtype) return null;
  const normalized = normalizeMemorySubtype(kind, subtype);
  if (normalized) return normalized;

  const normalizedKind = normalizeKind(kind);
  const allowed = MEMORY_SUBTYPES[normalizedKind];
  const allowedText = allowed.length > 0 ? allowed.join(", ") : "none";
  throw new Error(
    `Invalid memory_subtype "${subtype}" for kind "${normalizedKind}". Allowed subtypes: ${allowedText}.`,
  );
}

export function defaultMemorySubtypeForKind(kind: string | null | undefined): MemorySubtype | null {
  return DEFAULT_MEMORY_SUBTYPE_BY_KIND[normalizeKind(kind)];
}

export function categoryForMemorySubtype(subtype: string | null | undefined): Category | null {
  const normalized = normalizeToken(subtype);
  if (normalized in MEMORY_SUBTYPE_DEFAULT_CATEGORY) {
    return MEMORY_SUBTYPE_DEFAULT_CATEGORY[normalized as MemorySubtype];
  }
  return null;
}

export function layerForMemorySubtype(subtype: string | null | undefined): Layer | null {
  const normalized = normalizeToken(subtype);
  if (normalized in MEMORY_SUBTYPE_DEFAULT_LAYER) {
    return MEMORY_SUBTYPE_DEFAULT_LAYER[normalized as MemorySubtype];
  }
  return null;
}

export function normalizeEntities(entities: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entity of entities) {
    const normalized = entity.trim().toLowerCase();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

export function inferEntities(content: string): string[] {
  const entities: string[] = [];

  // Backtick code refs
  const codeRefs = content.match(/`([^`]+)`/g);
  if (codeRefs) {
    for (const ref of codeRefs) {
      entities.push(ref.slice(1, -1));
    }
  }

  // Package-like names: qdrant, postgres, react, etc.
  const techTerms = content.match(
    /\b(qdrant|postgres|postgresql|redis|docker|kubernetes|k8s|react|typescript|node|python|aws|gcp|azure|github|gitlab|notion|slack)\b/gi,
  );
  if (techTerms) {
    entities.push(...techTerms);
  }

  return normalizeEntities(entities).slice(0, 10);
}

export function getDecayHalfLife(input: {
  category?: string | null;
  domain?: string | null;
  kind?: string | null;
}): number | null {
  const kind = normalizeKind(input.kind);
  if (kind === "relation" || kind === "telemetry") return null;

  const rawCategory = normalizeToken(input.category);
  const categoryWasProvided = rawCategory.length > 0;
  const categoryIsKnown =
    rawCategory in CATEGORIES ||
    rawCategory.includes("product") ||
    rawCategory.includes("domain") ||
    rawCategory.includes("roadmap") ||
    rawCategory.includes("requirement") ||
    rawCategory.includes("workflow") ||
    rawCategory.includes("metric") ||
    rawCategory.includes("market") ||
    rawCategory.includes("customer") ||
    rawCategory === "projects" ||
    rawCategory.includes("human") ||
    rawCategory.includes("people") ||
    rawCategory.includes("person") ||
    rawCategory.includes("owner") ||
    rawCategory.includes("team") ||
    rawCategory.includes("preference") ||
    rawCategory.includes("agreement") ||
    rawCategory.includes("activity") ||
    rawCategory.includes("actor") ||
    rawCategory.includes("system") ||
    rawCategory.includes("session") ||
    rawCategory.includes("episode") ||
    rawCategory.includes("workstream") ||
    rawCategory.includes("telemetry") ||
    rawCategory.includes("feedback") ||
    rawCategory.includes("outcome") ||
    rawCategory.includes("rollup") ||
    rawCategory.includes("infra") ||
    rawCategory.includes("decision") ||
    rawCategory.includes("operation") ||
    rawCategory.includes("runbook") ||
    rawCategory.includes("repo") ||
    rawCategory.includes("code") ||
    rawCategory.includes("architecture") ||
    rawCategory.includes("troubleshoot") ||
    rawCategory.includes("observation");
  if (categoryWasProvided && !categoryIsKnown) {
    return DECAY_DEFAULT_HALF_LIFE;
  }

  const canonicalCategory = normalizeCategory(input.category);
  const canonicalDomain = normalizeDomain(input.domain);

  return (
    DECAY_HALF_LIFE[`${canonicalCategory}.${canonicalDomain}`] ??
    DECAY_HALF_LIFE[`${canonicalCategory}.${DEFAULT_DOMAIN}`] ??
    DECAY_DEFAULT_HALF_LIFE
  );
}

// ---------------------------------------------------------------------------
// Validation helpers for tool schemas
// ---------------------------------------------------------------------------

export function categoryValues(): NonEmptyStringArray {
  return Object.keys(CATEGORIES) as NonEmptyStringArray;
}

export function canonicalCategoryValues(): NonEmptyStringArray {
  return Object.keys(CATEGORIES) as NonEmptyStringArray;
}

export function domainValues(): NonEmptyStringArray {
  return Object.keys(DOMAINS) as NonEmptyStringArray;
}

export function canonicalDomainValues(): NonEmptyStringArray {
  return Object.keys(DOMAINS) as NonEmptyStringArray;
}

export function kindValues(): NonEmptyStringArray {
  return Object.keys(KINDS) as NonEmptyStringArray;
}

export function layerValues(): NonEmptyStringArray {
  return Object.keys(LAYERS) as NonEmptyStringArray;
}

// ---------------------------------------------------------------------------
// Prompt rendering helpers — single source of truth shared with src/prompts/*
// ---------------------------------------------------------------------------

/**
 * Render the documentation block for a single category — used inside LLM prompts
 * so the model sees the same description and examples that taxonomy.ts declares
 * as canonical. Keeps prompts and code in sync.
 */
export function categoryPromptSection(category: string): string {
  const def = (CATEGORIES as Record<string, { description?: string; examples?: readonly string[] }>)[category];
  if (!def) return `### ${category}\n(unknown category)`;
  const examples = (def.examples ?? []).map((ex) => `  • ${ex}`).join("\n");
  return [
    `### ${category}`,
    def.description ?? "",
    examples ? `Examples:\n${examples}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Render every category section back-to-back. */
export function allCategoryPromptSections(): string {
  return Object.keys(CATEGORIES).map(categoryPromptSection).join("\n\n");
}

// ---------------------------------------------------------------------------
// MCP enum descriptions — single source of truth shared with src/mcp/tools.ts
// ---------------------------------------------------------------------------
//
// These render the canonical CATEGORIES / DOMAINS / KINDS / MEMORY_SUBTYPES /
// SOURCES tables into the multiline strings agents see when they inspect a
// tool schema. Keeping them here means tool descriptions never drift from
// the ontology definitions above.

function shortenDescription(text: string): string {
  // Collapse any whitespace and clip to the first sentence so per-value
  // blurbs stay readable inside a tool schema description.
  const collapsed = text.replace(/\s+/g, " ").trim();
  const firstPeriod = collapsed.indexOf(". ");
  if (firstPeriod > 0) return collapsed.slice(0, firstPeriod + 1);
  return collapsed;
}

/** Render the `category` enum description for memory_store / memory_recall. */
export function categoryEnumDescription(): string {
  const lines = Object.entries(CATEGORIES).map(
    ([name, def]) => `  • ${name} — ${shortenDescription(def.description)}`,
  );
  return [
    "Subject matter of the fact. One of:",
    ...lines,
    `Default when omitted: ${DEFAULT_CATEGORY}.`,
  ].join("\n");
}

/** Render the `domain` enum description. */
export function domainEnumDescription(): string {
  const lines = Object.entries(DOMAINS).map(
    ([name, def]) => `  • ${name} — ${shortenDescription(def.description)}`,
  );
  return [
    "Activity profile that controls vocabulary and ranking. One of:",
    ...lines,
    `Default when omitted: ${DEFAULT_DOMAIN}.`,
  ].join("\n");
}

/** Render the `kind` enum description. Telemetry is daemon-only — excluded. */
export function kindEnumDescription(): string {
  const lines = Object.entries(KINDS)
    .filter(([name]) => name !== "telemetry")
    .map(([name, def]) => `  • ${name} — ${shortenDescription(def.description)}`);
  return [
    "Knowledge form of the memory object. One of:",
    ...lines,
    `Default when omitted: ${DEFAULT_KIND}. (telemetry is reserved for the daemon.)`,
  ].join("\n");
}

/**
 * Render the `memory_subtype` enum description, grouped by kind so the agent
 * knows which subtypes pair with which kind (the runtime enforces this via
 * validateMemorySubtype).
 */
export function memorySubtypeEnumDescription(): string {
  const groups = Object.entries(MEMORY_SUBTYPES)
    .filter(([, subtypes]) => subtypes.length > 0)
    .map(([kind, subtypes]) => `  • kind=${kind}: ${subtypes.join(", ")}`);
  return [
    "Optional finer-grained type within the kind. Only set when one of these clearly applies — otherwise leave blank.",
    "Subtype must match the kind (validated server-side):",
    ...groups,
  ].join("\n");
}

/** Render the `source` enum description for memory_store. */
export function sourceEnumDescription(): string {
  const lines = Object.entries(SOURCES).map(
    ([name, def]) => `  • ${name} — ${shortenDescription(def.description)}`,
  );
  return [
    "Who created this memory. One of:",
    ...lines,
    `Default when omitted: ${DEFAULT_SOURCE}. Only override when the human explicitly asked you to remember this (use 'user').`,
  ].join("\n");
}

export function memorySubtypeValues(): NonEmptyStringArray {
  return Object.values(MEMORY_SUBTYPES).flat() as NonEmptyStringArray;
}

export function memorySubtypeValuesForKind(kind: string | null | undefined): string[] {
  return [...MEMORY_SUBTYPES[normalizeKind(kind)]];
}

export function sourceValues(): NonEmptyStringArray {
  return Object.keys(SOURCES) as NonEmptyStringArray;
}
