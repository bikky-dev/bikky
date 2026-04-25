import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_BUDGETS,
  CAPTURE_KIND_SUBTYPES,
  CAPTURE_POLICY_VERSION,
  CAPTURE_TRIGGERS,
  DEFAULT_CAPTURE_CONTEXT,
  PROMPT_VERSIONS,
  QUALITY_THRESHOLDS,
  promptVersionForSubtype,
  subtypeForCategory,
} from "./capture-policy.js";

describe("daemon/capture-policy", () => {
  it("uses ontology v2 and software_engineering defaults", () => {
    assert.strictEqual(CAPTURE_POLICY_VERSION, "capture-policy-v2");
    assert.strictEqual(DEFAULT_CAPTURE_CONTEXT.domain, "software_engineering");
    assert.strictEqual(DEFAULT_CAPTURE_CONTEXT.source, "daemon");
    assert.strictEqual(DEFAULT_CAPTURE_CONTEXT.reviewStatus, "candidate");
  });

  it("keeps fact extraction cadence aligned with config defaults", () => {
    assert.strictEqual(CAPTURE_TRIGGERS.factExtraction.minEvents, 10);
    assert.strictEqual(CAPTURE_TRIGGERS.factExtraction.cooldownSeconds, 300);
    assert.ok(CAPTURE_TRIGGERS.factExtraction.maxEventsPerBatch > CAPTURE_TRIGGERS.factExtraction.minEvents);
  });

  it("defines bounded budgets for every first-slice object", () => {
    assert.ok(CAPTURE_BUDGETS.fact.maxFactsPerBatch > 0);
    assert.ok(CAPTURE_BUDGETS.episodeSummary.targetWords[0] < CAPTURE_BUDGETS.episodeSummary.targetWords[1]);
    assert.ok(CAPTURE_BUDGETS.workstreamSummary.targetWords[0] < CAPTURE_BUDGETS.workstreamSummary.targetWords[1]);
    assert.ok(CAPTURE_BUDGETS.distilled.maxSourceRefs > 0);
  });

  it("maps each capture kind to approved subtypes", () => {
    assert.ok(CAPTURE_KIND_SUBTYPES.fact?.includes("codebase_map"));
    assert.ok(CAPTURE_KIND_SUBTYPES.summary?.includes("episode"));
    assert.ok(CAPTURE_KIND_SUBTYPES.distilled?.includes("convention"));
  });

  it("maps categories to deterministic default fact subtypes", () => {
    assert.strictEqual(subtypeForCategory("codebase"), "codebase_map");
    assert.strictEqual(subtypeForCategory("infrastructure"), "infra_topology");
    assert.strictEqual(subtypeForCategory("people"), "ownership");
    assert.strictEqual(subtypeForCategory("preferences"), "preference");
  });

  it("selects prompt versions by subtype lifecycle", () => {
    assert.strictEqual(promptVersionForSubtype("codebase_map"), PROMPT_VERSIONS.factExtraction);
    assert.strictEqual(promptVersionForSubtype("session_index"), PROMPT_VERSIONS.sessionIndex);
    assert.strictEqual(promptVersionForSubtype("episode"), PROMPT_VERSIONS.episodeSummary);
    assert.strictEqual(promptVersionForSubtype("workstream"), PROMPT_VERSIONS.workstreamSummary);
    assert.strictEqual(promptVersionForSubtype("convention"), PROMPT_VERSIONS.distillation);
  });

  it("sets quality thresholds that reject weak daemon memories", () => {
    assert.ok(QUALITY_THRESHOLDS.minFactConfidence > 0.5);
    assert.ok(QUALITY_THRESHOLDS.minFactQualityScore > 0.5);
    assert.strictEqual(QUALITY_THRESHOLDS.rejectStatusOnlyFacts, true);
  });
});
