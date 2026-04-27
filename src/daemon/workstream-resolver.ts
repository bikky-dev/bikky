/**
 * Workstream key resolver.
 *
 * The episode-summary LLM emits a free-form `workstream_key` string. Without
 * normalisation, "fix wa-cron", "fix-wa-cron", and "Fix WA Cron" become three
 * different workstreams. This module fixes two problems:
 *
 *   1. **Deterministic extraction.** Many transcripts contain high-precision
 *      keys we shouldn't ask the LLM to find: GitHub issue/PR numbers, JIRA
 *      keys, branch names, task-folder slugs. We extract those first and let
 *      the LLM fall back only when they're absent.
 *
 *   2. **Canonicalization + alias absorption.** Whatever key we end up with
 *      (deterministic or LLM) is canonicalised (lowercase, ascii-fold,
 *      kebab-case) and matched against an alias registry so trivial rephrasings
 *      collapse onto the same canonical key.
 *
 * The registry is in-memory v1 — the daemon seeds it from a Qdrant scroll once
 * per inference cycle and discards it. Persisting the alias graph back to
 * Qdrant is a follow-up.
 */

export type WorkstreamSource = "deterministic" | "alias" | "llm-new" | "none";

export interface DeterministicKey {
  key: string;
  source: "issue" | "jira" | "branch" | "task-folder";
  confidence: number;
}

export interface ResolvedWorkstream {
  key: string | null;
  source: WorkstreamSource;
  reason: string;
}

export interface WorkstreamRegistry {
  /** Canonical → set of aliases (including the canonical itself). */
  canonicalToAliases: Map<string, Set<string>>;
  /** Alias → canonical (reverse index). */
  aliasToCanonical: Map<string, string>;
}

/** Empty in-memory registry. */
export const emptyRegistry = (): WorkstreamRegistry => ({
  canonicalToAliases: new Map(),
  aliasToCanonical: new Map(),
});

/**
 * Canonicalise a raw key:
 *  - lowercase
 *  - strip leading '#'
 *  - ascii-fold (best-effort: replace non-[a-z0-9] runs with '-')
 *  - collapse repeated '-'
 *  - trim leading/trailing '-'
 *
 * Returns empty string for inputs that contain no usable characters.
 */
export const canonicalizeKey = (raw: string): string => {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
};

/**
 * Tokens that look like JIRA keys but never are. Common protocol/encoding/
 * convention names that follow the same `LETTERS-DIGITS` shape.
 */
const JIRA_DENYLIST = new Set([
  "http", "https", "utf", "ascii", "iso", "rfc", "ietf", "ipv",
  "gh", "pr", "tcp", "udp", "sha", "md", "h2", "h3", "ws",
  "feat", "fix", "chore", "docs", "test", "perf", "ci", "build", "refactor",
]);

const DETERMINISTIC_PATTERNS: Array<{
  re: RegExp;
  source: DeterministicKey["source"];
  confidence: number;
  format: (m: RegExpMatchArray) => string;
  reject?: (m: RegExpMatchArray) => boolean;
}> = [
  // Task folder slug — highest precision (we created it ourselves).
  {
    re: /\btasks\/(\d{3}-[a-z0-9][a-z0-9-]*)/i,
    source: "task-folder",
    confidence: 0.95,
    format: (m) => m[1]!.toLowerCase(),
  },
  // GitHub issue/PR refs: #123, GH-123, gh-123. Checked BEFORE JIRA so
  // `GH-44` doesn't get misclassified as a JIRA project key.
  {
    re: /(?:^|[^A-Za-z0-9_])(?:#|gh-|GH-)(\d{1,6})\b/,
    source: "issue",
    confidence: 0.9,
    format: (m) => `gh-${m[1]}`,
  },
  {
    re: /\b(?:issue|pr|pull\s+request)\s*#?(\d{1,6})\b/i,
    source: "issue",
    confidence: 0.85,
    format: (m) => `gh-${m[1]}`,
  },
  // JIRA-style key: 3-6 uppercase letters + dash + digits (≥2 to avoid
  // matching things like `H2-1`). Reject known protocol/encoding tokens.
  {
    re: /\b([A-Z]{3,6})-(\d{2,})\b/,
    source: "jira",
    confidence: 0.95,
    format: (m) => `${m[1]!.toLowerCase()}-${m[2]}`,
    reject: (m) => JIRA_DENYLIST.has(m[1]!.toLowerCase()),
  },
  // Conventional branch names.
  {
    re: /\b(?:feat|fix|chore|refactor|docs|test|perf|ci|build)\/([a-z0-9][a-z0-9-]{2,40})\b/i,
    source: "branch",
    confidence: 0.85,
    format: (m) => m[1]!.toLowerCase(),
  },
];

/**
 * Scan the transcript for high-precision durable keys. Returns the first match
 * by pattern priority order; null if none found. We intentionally do not return
 * all matches — picking *one* canonical key is the whole point.
 */
export const extractDeterministicKey = (transcript: string): DeterministicKey | null => {
  if (!transcript || typeof transcript !== "string") return null;
  for (const pattern of DETERMINISTIC_PATTERNS) {
    const m = transcript.match(pattern.re);
    if (m) {
      const key = pattern.format(m);
      if (pattern.reject?.(m)) continue;
      if (key.length > 0) {
        return { key, source: pattern.source, confidence: pattern.confidence };
      }
    }
  }
  return null;
};

/** Add a canonical key to the registry, optionally with extra aliases. */
export const registerCanonical = (
  registry: WorkstreamRegistry,
  canonical: string,
  aliases: string[] = [],
): void => {
  const c = canonicalizeKey(canonical);
  if (!c) return;
  const set = registry.canonicalToAliases.get(c) ?? new Set<string>();
  set.add(c);
  registry.aliasToCanonical.set(c, c);
  for (const a of aliases) {
    const ac = canonicalizeKey(a);
    if (!ac) continue;
    set.add(ac);
    registry.aliasToCanonical.set(ac, c);
  }
  registry.canonicalToAliases.set(c, set);
};

/**
 * Resolve a workstream key for an episode.
 *
 * Decision order:
 *   1. Deterministic extraction from the transcript wins outright.
 *   2. Otherwise, canonicalise the LLM-proposed key. If it matches an existing
 *      alias in the registry, return the canonical for that alias.
 *   3. Otherwise, accept the canonicalised LLM key as a brand-new canonical
 *      (caller is responsible for registering it if desired).
 *   4. If neither source provides a usable key, return null.
 */
export const resolveWorkstreamKey = (input: {
  transcript: string;
  llmKey?: string | null;
  registry?: WorkstreamRegistry;
}): ResolvedWorkstream => {
  const registry = input.registry ?? emptyRegistry();

  const deterministic = extractDeterministicKey(input.transcript);
  if (deterministic) {
    const canonical = canonicalizeKey(deterministic.key);
    const known = registry.aliasToCanonical.get(canonical);
    return {
      key: known ?? canonical,
      source: known ? "alias" : "deterministic",
      reason: `deterministic ${deterministic.source} match (${deterministic.key})`,
    };
  }

  const llm = (input.llmKey ?? "").trim();
  if (!llm) {
    return { key: null, source: "none", reason: "no deterministic key found and LLM returned no key" };
  }

  const canonical = canonicalizeKey(llm);
  if (!canonical) {
    return { key: null, source: "none", reason: `LLM key "${llm}" canonicalised to empty string` };
  }

  const known = registry.aliasToCanonical.get(canonical);
  if (known) {
    return {
      key: known,
      source: "alias",
      reason: `LLM key "${llm}" matched existing canonical "${known}"`,
    };
  }

  return {
    key: canonical,
    source: "llm-new",
    reason: `LLM key "${llm}" registered as new canonical "${canonical}"`,
  };
};
