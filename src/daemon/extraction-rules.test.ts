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
