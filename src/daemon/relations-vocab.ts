/**
 * Relations vocabulary + entity stop-list.
 *
 * Two purposes:
 *
 * 1. STOP-LIST: filter out generic entity names that are not really entities
 *    ("error", "user", "test", "data", "fact"). They co-occur with everything
 *    and produce noisy relation candidates. Apply BEFORE pair generation.
 *
 * 2. CANONICAL RELATION TYPES: a small fixed vocabulary for `relation.type`.
 *    The LLM is free to propose anything but the daemon maps the result to
 *    a canonical label so storage stays queryable. Aliases collapse to the
 *    canonical form (e.g. "uses" / "depends_on" / "calls" → "depends-on").
 */

/**
 * Lowercase entity names that should NEVER form a relation pair.
 * Add an entry here when you spot a generic noun showing up in inferred
 * relations.
 */
export const GENERIC_ENTITY_STOP_LIST: ReadonlySet<string> = new Set([
  // Generic placeholders
  "user", "users", "client", "clients", "agent", "agents", "system", "systems",
  // Generic data words
  "data", "value", "values", "result", "results", "input", "output", "outputs",
  "content", "context", "message", "messages", "event", "events", "record", "records",
  // Generic engineering words
  "code", "test", "tests", "log", "logs", "config", "file", "files", "string",
  "number", "boolean", "array", "object", "function", "method", "type", "types",
  "error", "errors", "exception", "warning", "info", "debug",
  // Time / quantity words
  "today", "yesterday", "now", "time", "date", "hour", "minute", "second",
  "day", "week", "month", "year",
  // Bikky-specific noise
  "fact", "facts", "memory", "memories", "session", "sessions",
  "summary", "summaries", "relation", "relations",
]);

export const isGenericEntity = (entity: string): boolean => {
  return GENERIC_ENTITY_STOP_LIST.has(entity.trim().toLowerCase());
};

/**
 * Canonical relation labels. The daemon maps any LLM-proposed type to one of
 * these (or keeps the LLM type if no alias matches and it looks reasonable).
 */
export const CANONICAL_RELATION_TYPES = [
  "depends-on",      // X needs Y to function
  "calls",           // X invokes Y at runtime
  "owns",            // X is responsible for Y
  "produces",        // X emits Y
  "consumes",        // X reads Y
  "deploys-to",      // X is deployed to Y
  "runs-on",         // X executes on Y
  "stores-in",       // X persists data into Y
  "configures",      // X sets up Y
  "monitors",        // X observes Y
  "extends",         // X is a specialisation of Y
  "implements",      // X realises an interface Y
  "part-of",         // X is a sub-component of Y
  "alias-of",        // X is another name for Y
  "succeeds",        // X replaces / supersedes Y
  "decided",         // X made decision Y
  "prefers",         // X has preference Y
  "works-on",        // X is actively working on Y (people→project)
] as const;

export type CanonicalRelationType = typeof CANONICAL_RELATION_TYPES[number];

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_RELATION_TYPES);

/**
 * Aliases mapped to canonical types. Keys are the words an LLM might use;
 * values are the canonical replacement.
 *
 * Order: case-insensitive lookup, normalised (spaces/underscores → dashes,
 * verb stems collapsed) inside `mapToCanonical` before the lookup.
 */
const ALIASES: Readonly<Record<string, CanonicalRelationType>> = {
  // depends-on family
  "uses": "depends-on",
  "needs": "depends-on",
  "requires": "depends-on",
  "depends": "depends-on",
  "depends-upon": "depends-on",
  "relies-on": "depends-on",
  "built-on": "depends-on",
  // calls family
  "invokes": "calls",
  "triggers": "calls",
  "fires": "calls",
  "sends-to": "calls",
  "dispatches-to": "calls",
  // owns family
  "manages": "owns",
  "maintains": "owns",
  "responsible-for": "owns",
  "administers": "owns",
  // produces family
  "emits": "produces",
  "writes": "produces",
  "publishes": "produces",
  "generates": "produces",
  "creates": "produces",
  "outputs": "produces",
  // consumes family
  "reads": "consumes",
  "subscribes-to": "consumes",
  "ingests": "consumes",
  "loads-from": "consumes",
  // runs-on family
  "hosted-on": "runs-on",
  "executes-on": "runs-on",
  "running-on": "runs-on",
  // deploys-to family
  "deployed-to": "deploys-to",
  "ships-to": "deploys-to",
  "released-to": "deploys-to",
  // stores-in family
  "persists-in": "stores-in",
  "stored-in": "stores-in",
  "saves-to": "stores-in",
  "writes-to": "stores-in",
  // monitors family
  "observes": "monitors",
  "watches": "monitors",
  "alerts-on": "monitors",
  // part-of family
  "contains": "part-of",
  "included-in": "part-of",
  "belongs-to": "part-of",
  "child-of": "part-of",
  // alias-of family
  "same-as": "alias-of",
  "aka": "alias-of",
  "also-known-as": "alias-of",
  "renamed-from": "alias-of",
  // succeeds family
  "replaces": "succeeds",
  "supersedes": "succeeds",
  "obsoletes": "succeeds",
  // works-on family
  "assigned-to": "works-on",
  "working-on": "works-on",
  "leading": "works-on",
  // configures family
  "sets-up": "configures",
  "provisions": "configures",
};

const normalize = (raw: string): string => {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
};

export interface MappedRelationType {
  canonical: string;
  changed: boolean;
  /** True when the canonical label is in CANONICAL_RELATION_TYPES. */
  inVocabulary: boolean;
}

/**
 * Map an LLM-proposed relation type to a canonical label. Falls back to the
 * normalised input when no alias matches.
 */
export const mapToCanonical = (raw: string): MappedRelationType => {
  const normalised = normalize(raw);
  if (CANONICAL_SET.has(normalised)) {
    return { canonical: normalised, changed: false, inVocabulary: true };
  }
  const aliased = ALIASES[normalised];
  if (aliased) {
    return { canonical: aliased, changed: true, inVocabulary: true };
  }
  return { canonical: normalised, changed: normalised !== raw.trim().toLowerCase(), inVocabulary: false };
};

/**
 * For prompt injection: a human-readable list of canonical types with a
 * one-liner each.
 */
export const canonicalTypesForPrompt = (): string => {
  return CANONICAL_RELATION_TYPES.map((t) => `  - ${t}`).join("\n");
};
