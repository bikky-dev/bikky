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
    assert.strictEqual(fact.memory_subtype, "ownership");
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
