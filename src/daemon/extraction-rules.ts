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
