import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSubtype, scoreSubtype } from "./extraction-rules.js";

test("scoreSubtype: operational_procedure for deploy/rollout content", () => {
  const r = scoreSubtype("Run helm upgrade --install bikky and wait for rollout to complete.");
  assert.equal(r.subtype, "operational_procedure");
  assert.ok(r.score >= 1.0);
});

test("scoreSubtype: troubleshooting_gotcha for failure-mode content", () => {
  const r = scoreSubtype("Watch out: the WA cron silently fails when the suspended flag is set.");
  assert.equal(r.subtype, "troubleshooting_gotcha");
  assert.ok(r.score >= 1.0);
});

test("scoreSubtype: codebase_map for file-path content", () => {
  const r = scoreSubtype("Smoke tests live in packages/ui/tests/smoke.spec.ts.");
  assert.equal(r.subtype, "codebase_map");
});

test("scoreSubtype: infra_topology for cluster/service content", () => {
  const r = scoreSubtype("The lloyds cluster runs in eu-west-2 with an EKS node group and an RDS postgres.");
  assert.equal(r.subtype, "infra_topology");
});

test("scoreSubtype: architecture_decision for explicit-choice content", () => {
  const r = scoreSubtype("We chose Qdrant over Pinecone because of the ADR on self-hostable stores.");
  assert.equal(r.subtype, "architecture_decision");
});

test("scoreSubtype: access_pattern for auth content", () => {
  const r = scoreSubtype("Use the API key stored in 1Password at op://agent00/notion-api-key/credential for auth.");
  assert.equal(r.subtype, "access_pattern");
});

test("scoreSubtype: domain_rule for business-rule content", () => {
  const r = scoreSubtype("A scam session must reach an SLA of 30s before alerting; otherwise it is ineligible.");
  assert.equal(r.subtype, "domain_rule");
});

test("scoreSubtype: preference for personal-style content", () => {
  const r = scoreSubtype("I prefer kebab-case branch names by convention; that is my team's style.");
  assert.equal(r.subtype, "preference");
});

test("scoreSubtype: returns null subtype when no strong term hits", () => {
  const r = scoreSubtype("Random sentence with nothing distinctive in it at all.");
  assert.equal(r.subtype, null);
  assert.ok(r.score < 1.0);
});

test("compareSubtype: agree when LLM matches rule top-1", () => {
  const a = compareSubtype("Watch out: the cron silently fails on a certain edge case.", "troubleshooting_gotcha");
  assert.equal(a.verdict, "agree");
});

test("compareSubtype: agree when rule table has no opinion", () => {
  const a = compareSubtype("Bland and uninformative content.", "preference");
  assert.equal(a.verdict, "agree");
});

test("compareSubtype: disagree when LLM picks operational_procedure but content is a gotcha", () => {
  const a = compareSubtype(
    "Watch out: the cron silently fails when the suspended flag is set; the workaround is to clear it manually.",
    "operational_procedure",
  );
  assert.equal(a.verdict, "disagree");
  assert.equal(a.ruleSubtype, "troubleshooting_gotcha");
});

test("compareSubtype: agree (no flip) when scores are close — small margin", () => {
  // Mixed content where both subtypes have hits and the margin is small.
  const a = compareSubtype(
    "Run kubectl rollout restart; if it fails, watch for the wedged-pod gotcha.",
    "operational_procedure",
  );
  // Rule top-1 may be operational_procedure or troubleshooting_gotcha here;
  // the contract is: if scores are close (margin < 0.6), the verdict is agree.
  if (a.verdict === "disagree") {
    assert.ok(a.margin >= 0.6, `margin ${a.margin} should be >= 0.6 to disagree`);
  }
});

// ── Phase 2: grounding + volatility coherence verifiers ─────────────────────

import {
  hasTypedToken,
  subjectResolves,
  verifyGrounding,
  verifyVolatilityCoherence,
} from "./extraction-rules.js";

test("hasTypedToken: detects file paths with extensions", () => {
  assert.ok(hasTypedToken("Smoke tests live in packages/ui/tests/smoke.spec.ts."));
});

test("hasTypedToken: detects URLs", () => {
  assert.ok(hasTypedToken("See https://example.com/docs for more."));
});

test("hasTypedToken: detects backtick code spans", () => {
  assert.ok(hasTypedToken("Use the `BIKKY_COLLECTION` env var."));
});

test("hasTypedToken: detects kebab-case identifiers", () => {
  assert.ok(hasTypedToken("The dbt-run-cronjob-v100 schedules nightly runs."));
});

test("hasTypedToken: detects camelCase identifiers", () => {
  assert.ok(hasTypedToken("The factQualitySignals function lives in extraction.ts."));
});

test("hasTypedToken: rejects pure prose", () => {
  assert.equal(hasTypedToken("the pipeline uses pre-built images for deployment"), false);
});

test("subjectResolves: matches by entity inclusion", () => {
  assert.ok(subjectResolves("the foo cronjob", ["foo"]));
});

test("subjectResolves: matches when subject is a typed token", () => {
  assert.ok(subjectResolves("packages/ui/tests/smoke.spec.ts", []));
});

test("subjectResolves: rejects bare common nouns with no entity match", () => {
  assert.equal(subjectResolves("the pipeline", ["bikky"]), false);
});

test("verifyGrounding: rejects ungrounded prose with vague subject", () => {
  // EX1 from prompt: "The pipeline uses pre-built Docker images pulled from ECR."
  // No typed token, generic subject — should be REJECTED.
  const r = verifyGrounding({
    content: "The pipeline uses pre-built Docker images pulled from ECR.",
    subject: "the pipeline",
    subject_specificity: 0.2,
    self_contained: false,
    entities: ["docker", "ecr"],
  });
  assert.equal(r.verdict, "ungrounded");
});

test("verifyGrounding: accepts well-grounded fact with typed subject", () => {
  const r = verifyGrounding({
    content: "The CI workflow .github/workflows/release.yml builds Docker images.",
    subject: ".github/workflows/release.yml",
    subject_specificity: 0.95,
    self_contained: true,
    entities: ["bikky-dev/bikky"],
  });
  assert.equal(r.verdict, "grounded");
});

test("verifyGrounding: rejects 'Step 2' style episode-relative subject", () => {
  // EX3 from prompt: "Step 2 is part of the dbt cronjob."
  const r = verifyGrounding({
    content: "Step 2 is part of the dbt cronjob.",
    subject: "Step 2",
    subject_specificity: 0.0,
    self_contained: false,
    entities: ["dbt"],
  });
  assert.equal(r.verdict, "ungrounded");
});

test("verifyGrounding: downgrades to ambiguous when LLM is mid-confident", () => {
  // typed token rescues, but LLM only rates 0.4 on subject_specificity.
  const r = verifyGrounding({
    content: "The deploy.sh script is the entry point.",
    subject: "deploy.sh",
    subject_specificity: 0.4,
    self_contained: false,
    entities: [],
  });
  // Has typed token (deploy.sh) so not ungrounded; self_contained=false → ambiguous.
  assert.equal(r.verdict, "ambiguous");
});

test("verifyVolatilityCoherence: transient gets 30d expiry and observations category", () => {
  const r = verifyVolatilityCoherence({
    volatility: "transient",
    as_of: "2026-04-28",
    category: "infrastructure",
  });
  assert.equal(r.effective, "transient");
  assert.equal(r.forcedCategory, "observations");
  assert.equal(r.halfLifeMultiplier, 0.25);
  assert.ok(r.expiresAt);
  // 30 days after 2026-04-28 is 2026-05-28
  assert.ok(r.expiresAt!.startsWith("2026-05-28"));
});

test("verifyVolatilityCoherence: ephemeral gets 7d expiry and observations category", () => {
  const r = verifyVolatilityCoherence({
    volatility: "ephemeral",
    as_of: "2026-04-28",
    category: "operations",
  });
  assert.equal(r.effective, "ephemeral");
  assert.equal(r.forcedCategory, "observations");
  assert.equal(r.halfLifeMultiplier, 0.1);
  assert.ok(r.expiresAt!.startsWith("2026-05-05"));
});

test("verifyVolatilityCoherence: stable / evolving leave category alone with no expiry", () => {
  const stable = verifyVolatilityCoherence({ volatility: "stable", category: "codebase" });
  assert.equal(stable.expiresAt, null);
  assert.equal(stable.forcedCategory, null);
  assert.equal(stable.halfLifeMultiplier, 1.0);

  const evolving = verifyVolatilityCoherence({ volatility: "evolving", category: "infrastructure" });
  assert.equal(evolving.expiresAt, null);
  assert.equal(evolving.forcedCategory, null);
});

test("verifyVolatilityCoherence: synthesises as_of when missing for transient", () => {
  const r = verifyVolatilityCoherence({ volatility: "transient", category: "observations" });
  assert.equal(r.effective, "transient");
  assert.ok(r.expiresAt);
  assert.ok(r.notes.some((n) => n.includes("as_of synthesised")));
});

test("verifyVolatilityCoherence: missing volatility defaults to evolving (not stable)", () => {
  const r = verifyVolatilityCoherence({ category: "codebase" });
  assert.equal(r.effective, "evolving");
  assert.ok(r.notes.some((n) => n.includes("defaulted to 'evolving'")));
});
