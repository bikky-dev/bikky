/**
 * Subtype rule table.
 *
 * The extraction LLM picks a `memory_subtype` from 8 fact subtypes. A few
 * subtype pairs are easy to confuse:
 *
 *   - operational_procedure  vs  troubleshooting_gotcha
 *   - codebase_map           vs  infra_topology
 *   - domain_rule            vs  preference
 *
 * This module backstops the LLM with a lightweight keyword scorer. It returns a
 * deterministic top-1 subtype + score for a fact's content, so the daemon can:
 *
 *   - flag facts where the LLM and the rule table strongly disagree
 *     (set `review_status: candidate` so a human can verify)
 *   - downgrade confidence when nothing scores above a floor
 *
 * The table is intentionally small. It is NOT the source of truth — the LLM is.
 * The rule table is a cheap consistency check.
 */

export type FactSubtype =
  | "codebase_map"
  | "architecture_decision"
  | "infra_topology"
  | "access_pattern"
  | "operational_procedure"
  | "domain_rule"
  | "troubleshooting_gotcha"
  | "preference";

export interface SubtypeRuleScore {
  subtype: FactSubtype | null;
  score: number;
  scores: Record<FactSubtype, number>;
}

interface RuleTerm {
  re: RegExp;
  weight: number;
}

const RULES: Record<FactSubtype, RuleTerm[]> = {
  operational_procedure: [
    { re: /\b(?:rollout|rollback|deploy(?:ment|ed|ing)?|release|cron|schedul(?:e|ed))\b/i, weight: 1.0 },
    { re: /\b(?:helm|kubectl|terraform|ansible|argo|flux|aws\b)/i, weight: 0.8 },
    { re: /\b(?:procedure|runbook|playbook|step\s*\d|first[\s,]+then)\b/i, weight: 0.9 },
    { re: /\b(?:maintenance|incident|on-call|oncall|backfill|migration|cutover)\b/i, weight: 0.8 },
  ],
  troubleshooting_gotcha: [
    { re: /\b(?:gotcha|caveat|watch\s+out|beware|warning|broken|breaks?)\b/i, weight: 1.0 },
    { re: /\b(?:fails?|failing|error|exception|stack\s*trace|crash(?:es|ed|ing)?)\b/i, weight: 0.7 },
    { re: /\b(?:workaround|hack|fix|patch|bug)\b/i, weight: 0.7 },
    { re: /\b(?:silently|unexpected|surprising|tricky|subtle)\b/i, weight: 0.8 },
  ],
  codebase_map: [
    { re: /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|sql|sh|md|ya?ml|toml|json)\b/i, weight: 1.0 },
    { re: /\b(?:module|package|class|function|method|symbol|interface|export|import)\b/i, weight: 0.7 },
    { re: /\b(?:src|lib|tests?|packages|apps|services|cmd|internal|pkg)\/[\w./-]+/i, weight: 0.9 },
    { re: /\b(?:repo|repository|monorepo|workspace)\b/i, weight: 0.5 },
  ],
  infra_topology: [
    { re: /\b(?:cluster|namespace|pod|deployment|service|ingress|node|vpc|subnet|region|az)\b/i, weight: 0.9 },
    { re: /\b(?:s3|rds|sqs|sns|ec2|eks|ecs|lambda|fargate|kinesis|dynamodb|cloudfront)\b/i, weight: 0.9 },
    { re: /\b(?:postgres(?:ql)?|mysql|redis|kafka|rabbitmq|clickhouse|mongo)\b/i, weight: 0.8 },
    { re: /\b(?:queue|topic|database|cache|broker|gateway|load\s*balancer)\b/i, weight: 0.5 },
  ],
  architecture_decision: [
    { re: /\b(?:we\s+(?:chose|decided|picked|selected)|chosen\s+over|preferred\s+over)\b/i, weight: 1.0 },
    { re: /\b(?:rationale|because|trade[\s-]*off|alternative|considered)\b/i, weight: 0.7 },
    { re: /\b(?:adr|design\s+decision|architectural\s+decision|policy\s+decision)\b/i, weight: 1.0 },
    { re: /\b(?:standard(?:ise|ize)?d?|convention|approach|strategy)\b/i, weight: 0.5 },
  ],
  access_pattern: [
    { re: /\b(?:auth(?:n|z|entication|orization)?|oauth|jwt|saml|sso|api[\s-]*key|token)\b/i, weight: 1.0 },
    { re: /\b(?:role|permission|grant|policy|iam|rbac|acl)\b/i, weight: 0.9 },
    { re: /\b(?:approval|approver|review(?:er)?|gate|sign[\s-]*off)\b/i, weight: 0.6 },
    { re: /\b(?:credential|secret|vault|1password|op\s+read)\b/i, weight: 0.7 },
  ],
  domain_rule: [
    { re: /\b(?:must|shall|required|mandatory|invalid\s+if|only\s+if|unless)\b/i, weight: 0.8 },
    { re: /\b(?:business\s+rule|policy|regulation|sla|slo|kpi|metric)\b/i, weight: 1.0 },
    { re: /\b(?:workflow|lifecycle|stage|status\s+transition)\b/i, weight: 0.6 },
    { re: /\b(?:eligible|ineligible|allowed|forbidden|prohibited)\b/i, weight: 0.7 },
  ],
  preference: [
    { re: /\b(?:prefer(?:s|red|ence)?|like(?:s|d)?\s+to|tend(?:s|ed)?\s+to)\b/i, weight: 1.0 },
    { re: /\b(?:my|our|team['']?s|user['']?s)\s+(?:style|convention|habit)\b/i, weight: 0.8 },
    { re: /\b(?:always|never|usually|by\s+default)\b/i, weight: 0.4 },
    { re: /\b(?:opinion|taste|personal)\b/i, weight: 0.6 },
  ],
};

const SUBTYPES = Object.keys(RULES) as FactSubtype[];

/**
 * Score `content` against every subtype's rule terms. Returns the top-1
 * subtype + raw score, plus all scores for inspection.
 */
export const scoreSubtype = (content: string): SubtypeRuleScore => {
  const text = content || "";
  const scores = {} as Record<FactSubtype, number>;
  let topSubtype: FactSubtype | null = null;
  let topScore = 0;

  for (const subtype of SUBTYPES) {
    let total = 0;
    for (const term of RULES[subtype]) {
      if (term.re.test(text)) total += term.weight;
    }
    scores[subtype] = total;
    if (total > topScore) {
      topScore = total;
      topSubtype = subtype;
    }
  }

  // Require at least one strong term hit (weight >= 1.0 → score >= 1.0) before
  // we trust the rule table. Below that threshold we yield no opinion.
  if (topScore < 1.0) {
    return { subtype: null, score: topScore, scores };
  }

  return { subtype: topSubtype, score: topScore, scores };
};

/**
 * Compare the LLM's subtype choice against the rule table.
 *
 * Returns:
 *   - `agree`      — rule table top-1 matches (or has no opinion)
 *   - `disagree`   — rule table is confident in a *different* subtype with a
 *     margin large enough to suspect the LLM. Caller should mark the fact as
 *     `review_status: candidate` and lower confidence.
 */
export interface SubtypeAgreement {
  verdict: "agree" | "disagree";
  ruleSubtype: FactSubtype | null;
  ruleScore: number;
  margin: number;
}

const DISAGREEMENT_MARGIN = 0.6;

export const compareSubtype = (
  content: string,
  llmSubtype: string | null | undefined,
): SubtypeAgreement => {
  const score = scoreSubtype(content);
  if (!score.subtype) {
    return { verdict: "agree", ruleSubtype: null, ruleScore: score.score, margin: 0 };
  }
  if (!llmSubtype || score.subtype === llmSubtype) {
    return { verdict: "agree", ruleSubtype: score.subtype, ruleScore: score.score, margin: 0 };
  }
  const llmScore = (score.scores as Record<string, number>)[llmSubtype] ?? 0;
  const margin = score.score - llmScore;
  if (margin >= DISAGREEMENT_MARGIN) {
    return { verdict: "disagree", ruleSubtype: score.subtype, ruleScore: score.score, margin };
  }
  return { verdict: "agree", ruleSubtype: score.subtype, ruleScore: score.score, margin };
};

// ── Phase 2: structural grounding + volatility coherence verifiers ──────────
//
// These verifiers translate the LLM's self-judged fields (subject_specificity,
// volatility, self_contained, as_of) into store-time decisions. They are
// SHAPE-BASED, not vocabulary-based — no hand-curated lists of "vague words"
// or "transient markers". The detection criteria are:
//
//   - typed token shape (path, URL, code-formatted span, identifier shape)
//   - subject resolution against the entities array
//   - structural coherence (transient ⇒ as_of present, ephemeral ⇒ observations)
//
// The LLM remains source of truth — we only DOWNGRADE/REJECT/FLAG, never
// silently rewrite content.

export type GroundingVerdict = "grounded" | "ambiguous" | "ungrounded";

export interface GroundingResult {
  verdict: GroundingVerdict;
  reason: string;
  hasTypedToken: boolean;
  subjectResolves: boolean;
}

/**
 * Shape-based typed-token detector. A "typed token" is any substring that an
 * engineer could plausibly grep for and find a unique referent: file paths,
 * URLs, code-formatted spans, version strings, issue/PR refs, identifier-shaped
 * names (kebab-case / snake_case / dotted / camelCase ≥ 3 chars).
 *
 * Intentionally shape-only — no hardcoded tool/service vocabulary.
 */
export const hasTypedToken = (content: string): boolean => {
  const text = content || "";
  return Boolean(
    // Backtick-quoted code spans
    /`[^`\n]{2,}`/.test(text) ||
    // URLs
    /\bhttps?:\/\/\S+/.test(text) ||
    // File paths (slash-separated with at least one segment containing a dot OR ≥ 3 segments)
    /(?:^|[\s(])(?:[\w.-]+\/){1,}[\w.-]+\.[a-z0-9]{1,8}(?=[\s),.;:]|$)/i.test(text) ||
    /(?:^|[\s(])(?:[\w.-]+\/){2,}[\w.-]+(?=[\s),.;:]|$)/.test(text) ||
    // Filenames with extension (no slash)
    /\b[\w.-]+\.(?:[a-z]{1,4}|ya?ml|toml|json|sql|md)\b/i.test(text) ||
    // Issue / PR refs
    /(?:^|[\s(])#\d{2,}\b/.test(text) ||
    /\b(?:issue|pr|pull[- ]request)\s*#?\d+\b/i.test(text) ||
    // Version strings (semver-ish or hash-ish)
    /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/.test(text) ||
    /\b[0-9a-f]{7,40}\b/.test(text) ||
    // Constant-case identifiers (≥ 3 chars)
    /\b[A-Z][A-Z0-9_]{2,}\b/.test(text) ||
    // Dotted identifiers (a.b.c) — service names, package paths
    /\b[a-z][\w-]*(?:\.[\w-]+){2,}\b/.test(text) ||
    // Kebab/snake identifiers ≥ 8 chars containing a digit OR ≥ 2 separators
    // (filters out plain English compounds like "pre-built", "high-quality")
    /\b[a-z][a-z0-9]*[-_][a-z0-9-_]{4,}\b(?=.*\d|.*[-_].*[-_])/.test(text) ||
    // CamelCase identifiers (≥ 2 humps)
    /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]+\b/.test(text),
  );
};

/**
 * Returns true iff `subject` either:
 *   - looks like a typed token itself, OR
 *   - matches (case-insensitively) one of the entities the LLM extracted, OR
 *   - is a substring of one of the entities (or vice versa) — handles
 *     "the foo cronjob" vs entity "foo".
 *
 * Intentionally permissive — we want to catch the ungrounded cases, not
 * second-guess every wording choice.
 */
export const subjectResolves = (
  subject: string | null | undefined,
  entities: ReadonlyArray<string>,
): boolean => {
  const s = (subject || "").trim();
  if (!s) return false;
  if (hasTypedToken(s)) return true;

  const sLower = s.toLowerCase();
  for (const entity of entities) {
    const e = entity.toLowerCase();
    if (!e) continue;
    if (sLower === e) return true;
    if (sLower.includes(e) && e.length >= 3) return true;
    if (e.includes(sLower) && sLower.length >= 3) return true;
  }
  return false;
};

export interface GroundingInput {
  content: string;
  subject?: string | null;
  subject_specificity?: number | null;
  self_contained?: boolean | null;
  entities: ReadonlyArray<string>;
}

/**
 * Structural grounding gate. Combines:
 *   - typed-token presence in `content`
 *   - subject resolution against typed tokens or entities
 *   - LLM's own subject_specificity self-grade
 *   - LLM's own self_contained self-grade
 *
 * Verdict semantics (consumed by storeFacts):
 *   - grounded   → no action, store as-is
 *   - ambiguous  → keep, but lower confidence and flag in metadata
 *   - ungrounded → drop entirely
 */
export const verifyGrounding = (input: GroundingInput): GroundingResult => {
  const typed = hasTypedToken(input.content);
  const subjectOk = subjectResolves(input.subject, input.entities);
  const specificity = typeof input.subject_specificity === "number"
    ? input.subject_specificity
    : null;
  const selfContained = input.self_contained;

  // Hard reject conditions:
  //   1. The fact carries no typed token AND its subject does not resolve.
  //   2. The LLM rated subject_specificity below 0.3 AND the subject does not
  //      resolve to entities — a typed token elsewhere in `content` is NOT
  //      enough to rescue a vague subject (the subject is what the fact is
  //      ABOUT, the rest of the content is supporting detail).
  //   3. The LLM said the fact is not self-contained AND nothing rescues it.
  if (!typed && !subjectOk) {
    return {
      verdict: "ungrounded",
      reason: "no typed token and subject does not resolve to entities",
      hasTypedToken: typed,
      subjectResolves: subjectOk,
    };
  }
  if (specificity !== null && specificity < 0.3 && !subjectOk) {
    return {
      verdict: "ungrounded",
      reason: `LLM self-rated subject_specificity=${specificity}; subject does not resolve to entities`,
      hasTypedToken: typed,
      subjectResolves: subjectOk,
    };
  }
  if (selfContained === false && !subjectOk) {
    return {
      verdict: "ungrounded",
      reason: "LLM marked self_contained=false and subject does not resolve to entities",
      hasTypedToken: typed,
      subjectResolves: subjectOk,
    };
  }

  // Soft downgrade: subject resolves but LLM is not confident.
  if (specificity !== null && specificity < 0.5) {
    return {
      verdict: "ambiguous",
      reason: `LLM self-rated subject_specificity=${specificity}`,
      hasTypedToken: typed,
      subjectResolves: subjectOk,
    };
  }
  if (selfContained === false) {
    return {
      verdict: "ambiguous",
      reason: "LLM marked self_contained=false but subject resolves to entities",
      hasTypedToken: typed,
      subjectResolves: subjectOk,
    };
  }

  return {
    verdict: "grounded",
    reason: "typed token present and/or subject resolves",
    hasTypedToken: typed,
    subjectResolves: subjectOk,
  };
};

export type Volatility = "stable" | "evolving" | "transient" | "ephemeral";

export interface VolatilityInput {
  volatility?: Volatility | null;
  as_of?: string | null;
  category?: string | null;
}

export interface VolatilityCoherenceResult {
  /** Effective volatility after coherence checks (may be downgraded). */
  effective: Volatility;
  /** Effective category after coherence checks (may be forced to observations). */
  forcedCategory: string | null;
  /** Computed expires_at ISO timestamp, or null for stable/evolving. */
  expiresAt: string | null;
  /** valid_from anchor — `as_of` if supplied, else now. */
  validFrom: string;
  /** Half-life multiplier consumed by the recall ranker (Phase 3). */
  halfLifeMultiplier: number;
  /** Reasons applied during coherence checks, for metadata audit. */
  notes: string[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

const addDaysIso = (anchor: string, days: number): string => {
  const base = ISO_DATE_RE.test(anchor) ? new Date(`${anchor}T00:00:00Z`) : new Date();
  return new Date(base.getTime() + days * DAY_MS).toISOString();
};

/**
 * Translate the LLM's self-judged volatility into structural decisions:
 *   - transient  → expires_at = as_of + 30d, force category=observations,
 *                  half-life × 0.25
 *   - ephemeral  → expires_at = as_of + 7d, force category=observations,
 *                  half-life × 0.1
 *   - stable     → no expiry, half-life × 1.0
 *   - evolving   → no expiry, half-life × 1.0 (default)
 *
 * If the LLM emitted no volatility, defaults to "evolving" (NOT "stable") —
 * we err on the side of letting decay do its job.
 *
 * If volatility >= transient and `as_of` is missing, we fall back to today
 * and note the synthesis in the audit metadata.
 */
export const verifyVolatilityCoherence = (input: VolatilityInput): VolatilityCoherenceResult => {
  const notes: string[] = [];
  const effective: Volatility = input.volatility ?? "evolving";
  if (!input.volatility) notes.push("volatility defaulted to 'evolving' (LLM omitted)");

  let asOf = input.as_of && ISO_DATE_RE.test(input.as_of) ? input.as_of : null;
  if ((effective === "transient" || effective === "ephemeral") && !asOf) {
    asOf = isoDateOnly(new Date());
    notes.push(`as_of synthesised to ${asOf} (LLM omitted but volatility=${effective})`);
  }
  const validFrom = asOf
    ? new Date(`${asOf}T00:00:00Z`).toISOString()
    : new Date().toISOString();

  let expiresAt: string | null = null;
  let halfLifeMultiplier = 1.0;
  let forcedCategory: string | null = null;

  if (effective === "transient") {
    expiresAt = addDaysIso(asOf ?? isoDateOnly(new Date()), 30);
    halfLifeMultiplier = 0.25;
    if (input.category && input.category !== "observations") {
      forcedCategory = "observations";
      notes.push(`category forced to observations (was ${input.category}) — volatility=transient`);
    }
  } else if (effective === "ephemeral") {
    expiresAt = addDaysIso(asOf ?? isoDateOnly(new Date()), 7);
    halfLifeMultiplier = 0.1;
    if (input.category && input.category !== "observations") {
      forcedCategory = "observations";
      notes.push(`category forced to observations (was ${input.category}) — volatility=ephemeral`);
    }
  }

  return {
    effective,
    forcedCategory,
    expiresAt,
    validFrom,
    halfLifeMultiplier,
    notes,
  };
};
