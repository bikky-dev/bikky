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

export interface OntologyGroup {
  id: string;
  label: string;
  description: string;
  categories: string[];
  subtypes: string[];
}

export const CATEGORY_OPTIONS: OntologyOption[] = [
  { value: "codebase", label: "Codebase", description: "Repos, modules, files, APIs, and code navigation knowledge." },
  { value: "infrastructure", label: "Infrastructure", description: "Cloud, deployment, runtime, databases, CI/CD, and environments." },
  { value: "operations", label: "Operations", description: "Runbooks, incidents, maintenance, debugging steps, and gotchas." },
  { value: "decisions", label: "Decisions", description: "Architecture, product, process, and technical decisions with rationale." },
  { value: "product_domain", label: "Product domain", description: "Product concepts, workflows, business rules, and domain vocabulary." },
  { value: "projects", label: "Projects", description: "Goals, milestones, current state, blockers, and active workstreams." },
  { value: "people", label: "People", description: "Ownership, roles, collaboration patterns, and responsibilities." },
  { value: "preferences", label: "Preferences", description: "User, team, or workspace preferences about style, defaults, and tooling." },
  { value: "observations", label: "Observations", description: "Validated evidence, troubleshooting notes, and learned facts." },
];

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
    category: "codebase",
    description: "Where code lives and how to navigate repos, modules, files, and APIs.",
    example: "Use for repo maps, important files, entry points, or ownership notes.",
  },
  {
    value: "architecture_decision",
    label: "Architecture decision",
    kind: "fact",
    category: "decisions",
    description: "A technical or product decision plus the rationale behind it.",
    example: "Use for decisions that should guide future implementation choices.",
  },
  {
    value: "infra_topology",
    label: "Infrastructure topology",
    kind: "fact",
    category: "infrastructure",
    description: "How runtime infrastructure, services, databases, queues, and networks fit together.",
    example: "Use for deployment maps, cluster/service relationships, or data-flow topology.",
  },
  {
    value: "access_pattern",
    label: "Access pattern",
    kind: "fact",
    category: "infrastructure",
    description: "How to access a system, environment, dashboard, API, or operational tool.",
    example: "Use for safe connection paths, commands, URLs, or credential locations.",
  },
  {
    value: "operational_procedure",
    label: "Operational procedure",
    kind: "fact",
    category: "operations",
    description: "Repeatable steps for running, deploying, maintaining, or recovering something.",
    example: "Use for runbooks, rollout procedures, smoke checks, and recovery steps.",
  },
  {
    value: "domain_rule",
    label: "Domain rule",
    kind: "fact",
    category: "product_domain",
    description: "A product, workflow, business, or data rule that should be applied consistently.",
    example: "Use for invariant behavior, terminology, constraints, or product rules.",
  },
  {
    value: "troubleshooting_gotcha",
    label: "Troubleshooting gotcha",
    kind: "fact",
    category: "operations",
    description: "A surprising failure mode, workaround, or diagnostic clue worth remembering.",
    example: "Use for errors that look misleading or fixes that are easy to forget.",
  },
  {
    value: "preference",
    label: "Preference",
    kind: "fact",
    category: "preferences",
    description: "A user, team, or workspace preference about style, tooling, defaults, or workflow.",
    example: "Use for durable preferences that should shape future agent behavior.",
  },
  {
    value: "session_index",
    label: "Session index",
    kind: "summary",
    category: "projects",
    description: "A compact index of what happened in a work session and where to resume.",
    example: "Use for session closeouts and continuation pointers.",
  },
  {
    value: "episode",
    label: "Episode",
    kind: "summary",
    category: "projects",
    description: "A meaningful chunk of work across one or more sessions.",
    example: "Use for grouped implementation efforts, investigations, or releases.",
  },
  {
    value: "workstream",
    label: "Workstream",
    kind: "summary",
    category: "projects",
    description: "Longer-running project continuity: goals, status, blockers, and next actions.",
    example: "Use for active initiatives and roadmap-level progress.",
  },
  {
    value: "convention",
    label: "Convention",
    kind: "distilled",
    category: "observations",
    description: "A reusable pattern, norm, or lesson distilled from repeated work.",
    example: "Use for coding, operations, product, or collaboration conventions.",
  },
  {
    value: "recall_event",
    label: "Recall event",
    kind: "telemetry",
    category: "observations",
    description: "A signal that a memory was recalled and potentially used.",
    example: "Use for memory quality and relevance analysis.",
  },
  {
    value: "feedback_event",
    label: "Feedback event",
    kind: "telemetry",
    category: "observations",
    description: "A user or agent signal about whether a memory was useful, stale, or wrong.",
    example: "Use for memory quality feedback loops.",
  },
  {
    value: "outcome_event",
    label: "Outcome event",
    kind: "telemetry",
    category: "observations",
    description: "A result signal connecting memory use to task outcomes.",
    example: "Use for measuring whether memory helped complete work.",
  },
  {
    value: "aggregate_rollup",
    label: "Aggregate rollup",
    kind: "telemetry",
    category: "observations",
    description: "An aggregated quality, usage, or outcome summary.",
    example: "Use for dashboard-ready memory metrics.",
  },
];

export const ONTOLOGY_GROUPS: OntologyGroup[] = [
  {
    id: "codebase",
    label: "Codebase & architecture",
    description: "Where things live, how systems are structured, and why technical choices were made.",
    categories: ["codebase", "decisions"],
    subtypes: ["codebase_map", "architecture_decision"],
  },
  {
    id: "infra-ops",
    label: "Infrastructure & operations",
    description: "Runtime topology, access paths, runbooks, and debugging knowledge.",
    categories: ["infrastructure", "operations"],
    subtypes: ["infra_topology", "access_pattern", "operational_procedure", "troubleshooting_gotcha"],
  },
  {
    id: "product-projects",
    label: "Product & projects",
    description: "Product rules plus task, session, episode, and workstream continuity.",
    categories: ["product_domain", "projects"],
    subtypes: ["domain_rule", "session_index", "episode", "workstream"],
  },
  {
    id: "people-preferences",
    label: "People & preferences",
    description: "Ownership, collaboration context, and preferred ways of working.",
    categories: ["people", "preferences"],
    subtypes: ["preference"],
  },
  {
    id: "observations-learning",
    label: "Observations & learning",
    description: "Evidence, reusable conventions, and durable lessons learned.",
    categories: ["observations"],
    subtypes: ["convention"],
  },
  {
    id: "telemetry-feedback",
    label: "Telemetry & feedback",
    description: "Memory-use signals, feedback events, outcomes, and aggregate quality rollups.",
    categories: ["observations"],
    subtypes: ["recall_event", "feedback_event", "outcome_event", "aggregate_rollup"],
  },
];

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
