import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_EXTRACTION_PROMPT,
  factQualitySignals,
  isHighQualityExtractedFact,
  normalizeExtractedFact,
  type ExtractedFact,
} from "./extraction.js";

describe("daemon/extraction prompt", () => {
  it("describes memory ontology fields and avoids legacy domain wording", () => {
    assert.ok(DEFAULT_EXTRACTION_PROMPT.includes("software_engineering"));
    assert.ok(DEFAULT_EXTRACTION_PROMPT.includes("memory_subtype"));
    assert.ok(DEFAULT_EXTRACTION_PROMPT.includes("codebase_map"));
    assert.ok(!DEFAULT_EXTRACTION_PROMPT.includes("work or personal"));
    assert.ok(!DEFAULT_EXTRACTION_PROMPT.includes("Telegram"));
    assert.ok(!DEFAULT_EXTRACTION_PROMPT.includes("WhatsApp"));
  });
});

describe("normalizeExtractedFact", () => {
  it("uses canonical category names and assigns subtype metadata", () => {
    const fact = normalizeExtractedFact({
      content: "The root test suite uses Node's built-in test runner; run npm test before opening PRs.",
      category: "people",
      entities: ["Node", "npm-test"],
      confidence: 0.9,
      importance: 0.8,
      quality_score: 0.8,
    });

    assert.ok(fact);
    assert.strictEqual(fact.category, "people");
    assert.strictEqual(fact.memory_subtype, "preference");
    assert.deepStrictEqual(fact.entities, ["node", "npm-test"]);
  });

  it("accepts short durable preferences without padding", () => {
    const fact = normalizeExtractedFact({
      content: "Prefer Node's built-in test runner for daemon unit tests.",
      category: "preferences",
      memory_subtype: "preference",
      entities: ["node-test-runner"],
      confidence: 0.9,
      importance: 0.7,
      quality_score: 0.7,
    });

    assert.ok(fact);
    assert.strictEqual(fact.memory_subtype, "preference");
  });

  it("rejects skinny status-only memories", () => {
    const fact = normalizeExtractedFact({
      content: "The tests were fixed and now pass.",
      category: "observations",
      entities: [],
      confidence: 0.9,
      importance: 0.6,
      quality_score: 0.8,
    });

    assert.strictEqual(fact, null);
  });

  it("falls back from invalid subtype to the category default", () => {
    const fact = normalizeExtractedFact({
      content: "If Qdrant order_by fails, create a datetime payload index for the sorted field before retrying.",
      category: "operations",
      memory_subtype: "episode",
      entities: ["qdrant", "order_by"],
      confidence: 0.9,
      importance: 0.8,
      quality_score: 0.8,
    });

    assert.ok(fact);
    assert.strictEqual(fact.memory_subtype, "operational_procedure");
  });
});

describe("isHighQualityExtractedFact", () => {
  function makeFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
    return {
      content: "The UI smoke tests live in packages/ui/tests/smoke.spec.ts and run with npm run test:e2e.",
      category: "codebase",
      memory_subtype: "codebase_map",
      entities: ["packages/ui", "playwright"],
      confidence: 0.9,
      importance: 0.7,
      quality_score: 0.8,
      ...overrides,
    };
  }

  it("accepts facts with durable anchors", () => {
    assert.strictEqual(isHighQualityExtractedFact(makeFact()), true);
    const signals = factQualitySignals(makeFact());
    assert.strictEqual(signals.hasDurableAnchor, true);
    assert.strictEqual(signals.isStatusOnly, false);
  });

  it("rejects low-confidence, low-importance weak facts", () => {
    assert.strictEqual(isHighQualityExtractedFact(makeFact({
      content: "There may be something useful about the project.",
      entities: [],
      confidence: 0.4,
      importance: 0.4,
      quality_score: 0.9,
    })), false);
  });

  it("requires either an anchor or short-useful subtype", () => {
    assert.strictEqual(isHighQualityExtractedFact(makeFact({
      content: "The project has a couple of things to remember for later reference.",
      entities: [],
      memory_subtype: "codebase_map",
      confidence: 0.9,
      importance: 0.8,
      quality_score: 0.9,
    })), false);
  });
});

describe("normalizeExtractedFact — self-judgment fields (prompt v2026-04-28-1)", () => {
  it("parses subject, subject_specificity, volatility, self_contained, as_of", () => {
    const fact = normalizeExtractedFact({
      content: "The bikky-dev/bikky CI workflow .github/workflows/release.yml builds Docker images and pushes to ECR.",
      category: "infrastructure",
      memory_subtype: "infra_topology",
      entities: ["bikky-dev/bikky", "ecr"],
      confidence: 0.9,
      importance: 0.8,
      quality_score: 0.85,
      subject: ".github/workflows/release.yml",
      subject_specificity: 0.95,
      volatility: "stable",
      volatility_reason: "CI workflow file location is durable.",
      self_contained: true,
      repo: "bikky-dev/bikky",
    });

    assert.ok(fact);
    assert.strictEqual(fact.subject, ".github/workflows/release.yml");
    assert.strictEqual(fact.subject_specificity, 0.95);
    assert.strictEqual(fact.volatility, "stable");
    assert.strictEqual(fact.volatility_reason, "CI workflow file location is durable.");
    assert.strictEqual(fact.self_contained, true);
    assert.strictEqual(fact.as_of, null);
    assert.strictEqual(fact.repo, "bikky-dev/bikky");
  });

  it("clamps subject_specificity to [0,1] and rejects unknown volatility values", () => {
    const fact = normalizeExtractedFact({
      content: "The dbt-run-cronjob-v100-29617080 cronjob is currently running the old image.",
      category: "observations",
      memory_subtype: "troubleshooting_gotcha",
      entities: ["dbt-run-cronjob-v100-29617080"],
      confidence: 0.8,
      importance: 0.6,
      quality_score: 0.7,
      subject: "dbt-run-cronjob-v100-29617080",
      subject_specificity: 1.5,
      volatility: "VERY_TRANSIENT",
      self_contained: true,
      as_of: "2026-04-28",
    });

    assert.ok(fact);
    assert.strictEqual(fact.subject_specificity, 1);
    assert.strictEqual(fact.volatility, null, "unknown volatility values normalize to null");
    assert.strictEqual(fact.as_of, "2026-04-28");
  });

  it("ignores malformed as_of and missing self-judgment fields without dropping the fact", () => {
    const fact = normalizeExtractedFact({
      content: "The UI smoke tests live in packages/ui/tests/smoke.spec.ts and run with npm run test:e2e.",
      category: "codebase",
      memory_subtype: "codebase_map",
      entities: ["packages/ui"],
      confidence: 0.9,
      importance: 0.7,
      quality_score: 0.8,
      as_of: "yesterday",
    });

    assert.ok(fact, "fact without self-judgment fields should still be accepted");
    assert.strictEqual(fact.subject, null);
    assert.strictEqual(fact.subject_specificity, null);
    assert.strictEqual(fact.volatility, null);
    assert.strictEqual(fact.self_contained, null);
    assert.strictEqual(fact.as_of, null, "malformed as_of must be dropped");
  });
});

describe("factQualitySignals — self-judgment integration", () => {
  function baseFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
    return {
      content: "The UI smoke tests live in packages/ui/tests/smoke.spec.ts and run with npm run test:e2e.",
      category: "codebase",
      memory_subtype: "codebase_map",
      entities: ["packages/ui"],
      confidence: 0.9,
      importance: 0.7,
      quality_score: 0.8,
      ...overrides,
    };
  }

  it("boosts the quality score when subject_specificity is high", () => {
    const high = factQualitySignals(baseFact({ subject_specificity: 0.95 }));
    const baseline = factQualitySignals(baseFact());
    assert.ok(high.computedQualityScore >= baseline.computedQualityScore);
  });

  it("penalizes the quality score when subject_specificity is very low", () => {
    const low = factQualitySignals(baseFact({ subject_specificity: 0.1 }));
    const baseline = factQualitySignals(baseFact());
    assert.ok(low.computedQualityScore < baseline.computedQualityScore);
  });

  it("penalizes the quality score when self_contained is false", () => {
    const notSelf = factQualitySignals(baseFact({ self_contained: false }));
    const baseline = factQualitySignals(baseFact());
    assert.ok(notSelf.computedQualityScore < baseline.computedQualityScore);
  });
});
