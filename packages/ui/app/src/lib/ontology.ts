export interface OntologyOption {
  value: string;
  label: string;
  description?: string;
}

export interface MemorySubtypeOption extends OntologyOption {
  kind: string;
  category: string;
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
  { value: "codebase_map", label: "Codebase map", kind: "fact", category: "codebase" },
  { value: "architecture_decision", label: "Architecture decision", kind: "fact", category: "decisions" },
  { value: "infra_topology", label: "Infrastructure topology", kind: "fact", category: "infrastructure" },
  { value: "access_pattern", label: "Access pattern", kind: "fact", category: "infrastructure" },
  { value: "operational_procedure", label: "Operational procedure", kind: "fact", category: "operations" },
  { value: "domain_rule", label: "Domain rule", kind: "fact", category: "product_domain" },
  { value: "troubleshooting_gotcha", label: "Troubleshooting gotcha", kind: "fact", category: "operations" },
  { value: "preference", label: "Preference", kind: "fact", category: "preferences" },
  { value: "session_index", label: "Session index", kind: "summary", category: "projects" },
  { value: "episode", label: "Episode", kind: "summary", category: "projects" },
  { value: "workstream", label: "Workstream", kind: "summary", category: "projects" },
  { value: "convention", label: "Convention", kind: "distilled", category: "observations" },
  { value: "recall_event", label: "Recall event", kind: "telemetry", category: "observations" },
  { value: "feedback_event", label: "Feedback event", kind: "telemetry", category: "observations" },
  { value: "outcome_event", label: "Outcome event", kind: "telemetry", category: "observations" },
  { value: "aggregate_rollup", label: "Aggregate rollup", kind: "telemetry", category: "observations" },
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
