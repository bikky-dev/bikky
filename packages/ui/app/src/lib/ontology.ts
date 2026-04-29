export interface OntologyOption {
  value: string;
  label: string;
  description?: string;
}

export interface MemorySubtypeOption extends OntologyOption {
  kind: string;
  category: string;
  example?: string;
}

export const CATEGORY_OPTIONS: OntologyOption[] = [
  { value: "engineering", label: "Engineering", description: "Codebase maps, architecture decisions, infrastructure topology, access, operations, troubleshooting, and conventions." },
  { value: "product", label: "Product", description: "Domain rules, product decisions, requirements, user workflows, roadmap, success metrics, and market insight." },
  { value: "human", label: "Human", description: "Preferences, people, ownership, working agreements, and durable actor-action activity events." },
  { value: "system", label: "System", description: "Bikky lifecycle memory: sessions, episodes, workstreams, recall/feedback/outcome telemetry, and rollups." },
];

export const BROWSABLE_CATEGORY_OPTIONS: OntologyOption[] = CATEGORY_OPTIONS.filter(
  (category) => category.value !== "system",
);

export const DOMAIN_OPTIONS: OntologyOption[] = [
  { value: "software_engineering", label: "Software engineering" },
  { value: "product_strategy", label: "Product strategy" },
  { value: "business_operations", label: "Business operations" },
  { value: "research", label: "Research" },
  { value: "personal_productivity", label: "Personal productivity" },
];

export const KIND_OPTIONS: OntologyOption[] = [
  { value: "fact", label: "Fact" },
  { value: "summary", label: "Summary" },
  { value: "distilled", label: "Distilled" },
  { value: "relation", label: "Relation" },
  { value: "telemetry", label: "Telemetry" },
];

export const SOURCE_OPTIONS: OntologyOption[] = [
  { value: "agent", label: "Agent" },
  { value: "system", label: "System" },
  { value: "user", label: "User" },
  { value: "docs", label: "Docs" },
];

export const MEMORY_SUBTYPE_OPTIONS: MemorySubtypeOption[] = [
  {
    value: "codebase_map",
    label: "Codebase map",
    kind: "fact",
    category: "engineering",
    description: "Where code lives and how to navigate repos, modules, files, and APIs.",
    example: "Use for repo maps, important files, entry points, or ownership notes.",
  },
  {
    value: "architecture_decision",
    label: "Architecture decision",
    kind: "fact",
    category: "engineering",
    description: "An engineering, system design, infrastructure, or codebase decision plus rationale.",
    example: "Use for implementation choices that should guide future engineering work.",
  },
  {
    value: "infra_topology",
    label: "Infrastructure topology",
    kind: "fact",
    category: "engineering",
    description: "How runtime infrastructure, services, databases, queues, and networks fit together.",
    example: "Use for deployment maps, cluster/service relationships, or data-flow topology.",
  },
  {
    value: "access_pattern",
    label: "Access pattern",
    kind: "fact",
    category: "engineering",
    description: "How to access a system, environment, dashboard, API, or operational tool.",
    example: "Use for safe connection paths, commands, URLs, or credential locations.",
  },
  {
    value: "operational_procedure",
    label: "Operational procedure",
    kind: "fact",
    category: "engineering",
    description: "Repeatable steps for running, deploying, maintaining, or recovering something.",
    example: "Use for runbooks, rollout procedures, smoke checks, and recovery steps.",
  },
  {
    value: "domain_rule",
    label: "Domain rule",
    kind: "fact",
    category: "product",
    description: "A product, business, workflow, or data rule that should be applied consistently.",
    example: "Use for invariant behavior, terminology, constraints, or product rules.",
  },
  {
    value: "product_decision",
    label: "Product decision",
    kind: "fact",
    category: "product",
    description: "Product strategy, UX, positioning, prioritization, pricing, packaging, or roadmap trade-off with rationale.",
    example: "Use for product choices distinct from engineering implementation decisions.",
  },
  {
    value: "product_requirement",
    label: "Product requirement",
    kind: "fact",
    category: "product",
    description: "Feature requirement, acceptance criterion, UX expectation, or explicit product behavior.",
    example: "Use for what the product must support or show.",
  },
  {
    value: "user_workflow",
    label: "User workflow",
    kind: "fact",
    category: "product",
    description: "User journey, job-to-be-done, onboarding, or usage path.",
    example: "Use for how users move through the product.",
  },
  {
    value: "roadmap_item",
    label: "Roadmap item",
    kind: "fact",
    category: "product",
    description: "Priority, planned or deferred feature, release theme, milestone, or backlog item.",
    example: "Use for future work and roadmap continuity.",
  },
  {
    value: "success_metric",
    label: "Success metric",
    kind: "fact",
    category: "product",
    description: "KPI, activation, retention, adoption, quality metric, evaluation goal, or target.",
    example: "Use for measuring whether a product or feature is succeeding.",
  },
  {
    value: "market_insight",
    label: "Market insight",
    kind: "fact",
    category: "product",
    description: "Audience, positioning, customer/community feedback, competitor, launch, or GTM insight.",
    example: "Use for open-source adoption, market, or community learning.",
  },
  {
    value: "person_profile",
    label: "Person profile",
    kind: "fact",
    category: "human",
    description: "Durable role, expertise, team, or person context.",
    example: "Use for explicit people context that helps future collaboration.",
  },
  {
    value: "ownership_note",
    label: "Ownership note",
    kind: "fact",
    category: "human",
    description: "Owner, approver, escalation path, or accountability.",
    example: "Use for who owns or approves a project, component, or decision.",
  },
  {
    value: "working_agreement",
    label: "Working agreement",
    kind: "fact",
    category: "human",
    description: "Collaboration norm, operating rule, or approval expectation.",
    example: "Use for durable ways of working.",
  },
  {
    value: "activity_event",
    label: "Activity event",
    kind: "fact",
    category: "human",
    description: "Explicit actor-action-object event with durable project value.",
    example: "Use for state-changing actions like approvals, merges, releases, assignments, or decisions.",
  },
  {
    value: "troubleshooting_gotcha",
    label: "Troubleshooting gotcha",
    kind: "fact",
    category: "engineering",
    description: "A surprising failure mode, workaround, or diagnostic clue worth remembering.",
    example: "Use for errors that look misleading or fixes that are easy to forget.",
  },
  {
    value: "preference",
    label: "Preference",
    kind: "fact",
    category: "human",
    description: "A user, team, or workspace preference about style, tooling, defaults, or workflow.",
    example: "Use for durable preferences that should shape future agent behavior.",
  },
  {
    value: "session_index",
    label: "Session index",
    kind: "summary",
    category: "system",
    description: "A compact index of what happened in a work session and where to resume.",
    example: "Use for session closeouts and continuation pointers.",
  },
  {
    value: "episode",
    label: "Episode",
    kind: "summary",
    category: "system",
    description: "A meaningful chunk of work across one or more sessions.",
    example: "Use for grouped implementation efforts, investigations, or releases.",
  },
  {
    value: "workstream",
    label: "Workstream",
    kind: "summary",
    category: "system",
    description: "Longer-running project continuity: goals, status, blockers, and next actions.",
    example: "Use for active initiatives and roadmap-level progress.",
  },
  {
    value: "convention",
    label: "Convention",
    kind: "distilled",
    category: "engineering",
    description: "A reusable pattern, norm, or lesson distilled from repeated work.",
    example: "Use for coding, operational, or engineering conventions.",
  },
  {
    value: "recall_event",
    label: "Recall event",
    kind: "telemetry",
    category: "system",
    description: "A signal that a memory was recalled and potentially used.",
    example: "Use for memory quality and relevance analysis.",
  },
  {
    value: "feedback_event",
    label: "Feedback event",
    kind: "telemetry",
    category: "system",
    description: "A user or agent signal about whether a memory was useful, stale, or wrong.",
    example: "Use for memory quality feedback loops.",
  },
  {
    value: "outcome_event",
    label: "Outcome event",
    kind: "telemetry",
    category: "system",
    description: "A result signal connecting memory use to task outcomes.",
    example: "Use for measuring whether memory helped complete work.",
  },
  {
    value: "aggregate_rollup",
    label: "Aggregate rollup",
    kind: "telemetry",
    category: "system",
    description: "An aggregated quality, usage, or outcome summary.",
    example: "Use for dashboard-ready memory metrics.",
  },
];

export const SUBTYPES_BY_CATEGORY = Object.fromEntries(
  CATEGORY_OPTIONS.map((category) => [
    category.value,
    MEMORY_SUBTYPE_OPTIONS.filter((subtype) => subtype.category === category.value),
  ]),
) as Record<string, MemorySubtypeOption[]>;

export const BROWSABLE_SUBTYPES_BY_CATEGORY = Object.fromEntries(
  BROWSABLE_CATEGORY_OPTIONS.map((category) => [
    category.value,
    MEMORY_SUBTYPE_OPTIONS.filter((subtype) => subtype.category === category.value),
  ]),
) as Record<string, MemorySubtypeOption[]>;

export const SUBTYPE_BY_VALUE = Object.fromEntries(
  MEMORY_SUBTYPE_OPTIONS.map((subtype) => [subtype.value, subtype]),
) as Record<string, MemorySubtypeOption>;

const allOptions = [
  ...CATEGORY_OPTIONS,
  ...DOMAIN_OPTIONS,
  ...KIND_OPTIONS,
  ...SOURCE_OPTIONS,
  ...MEMORY_SUBTYPE_OPTIONS,
];

export function ontologyLabel(value: string | null | undefined): string {
  if (!value) return "";
  return allOptions.find((option) => option.value === value)?.label ?? value.replace(/_/g, " ");
}
