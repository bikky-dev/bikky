/**
 * Tests for the Bikky memory ontology.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORIES,
  DECAY_DEFAULT_HALF_LIFE,
  DEFAULT_DOMAIN,
  DEFAULT_KIND,
  DEFAULT_SOURCE,
  DOMAINS,
  LAYERS,
  MEMORY_SUBTYPES,
  QDRANT_INDEXES,
  SOURCES,
  STALENESS_DAYS,
  THRESHOLD_DUPLICATE,
  THRESHOLD_RELATED,
  canonicalCategoryValues,
  canonicalDomainValues,
  categoryForMemorySubtype,
  categoryValues,
  defaultMemorySubtypeForKind,
  domainValues,
  getDecayHalfLife,
  kindValues,
  layerForMemorySubtype,
  layerValues,
  memorySubtypeValues,
  memorySubtypeValuesForKind,
  normalizeCategory,
  normalizeDomain,
  normalizeKind,
  normalizeLayer,
  normalizeMemorySubtype,
  normalizeSource,
  sourceValues,
  validateMemorySubtype,
} from "./taxonomy.js";

describe("ontology values", () => {
  it("defines canonical software-engineering categories", () => {
    const values = canonicalCategoryValues();
    assert.deepStrictEqual(values, [
      "engineering",
      "product",
      "human",
      "system",
    ]);
  });

  it("exposes only canonical memory ontology categories", () => {
    assert.deepStrictEqual(categoryValues(), canonicalCategoryValues());
    assert.ok(!categoryValues().includes("observation"));
    assert.ok(!categoryValues().includes("team"));
  });

  it("defines domain profiles rather than work/personal scopes", () => {
    const values = canonicalDomainValues();
    assert.deepStrictEqual(values, [
      "software_engineering",
      "product_strategy",
      "business_operations",
      "research",
      "personal_productivity",
    ]);
    assert.deepStrictEqual(domainValues(), values);
    assert.ok(!domainValues().includes("work"));
    assert.ok(!domainValues().includes("personal"));
  });

  it("keeps stable kinds, sources, and layers", () => {
    assert.deepStrictEqual(kindValues(), ["fact", "summary", "distilled", "relation", "telemetry"]);
    assert.deepStrictEqual(sourceValues(), ["agent", "system", "user", "docs"]);
    assert.deepStrictEqual(layerValues(), [
      "workspace",
      "domain",
      "surface",
      "workstream",
      "episode",
      "memory_object",
    ]);
  });

  it("has descriptions and examples where useful", () => {
    for (const [key, def] of Object.entries(CATEGORIES)) {
      assert.ok(def.description, `${key} missing description`);
      assert.ok(def.examples.length > 0, `${key} missing examples`);
    }
    for (const [key, def] of Object.entries(DOMAINS)) {
      assert.ok(def.description, `${key} missing description`);
      assert.ok(def.defaultCategories.length > 0, `${key} missing default categories`);
    }
    for (const [key, def] of Object.entries(LAYERS)) {
      assert.ok(def.description, `${key} missing description`);
    }
    for (const [key, def] of Object.entries(SOURCES)) {
      assert.ok(def.description, `${key} missing description`);
    }
  });
});

describe("defaults and thresholds", () => {
  it("defaults to software_engineering facts from agents", () => {
    assert.strictEqual(DEFAULT_DOMAIN, "software_engineering");
    assert.strictEqual(DEFAULT_KIND, "fact");
    assert.strictEqual(DEFAULT_SOURCE, "agent");
  });

  it("keeps existing staleness and similarity thresholds", () => {
    assert.strictEqual(STALENESS_DAYS, 30);
    assert.strictEqual(DECAY_DEFAULT_HALF_LIFE, 90);
    assert.strictEqual(THRESHOLD_DUPLICATE, 0.92);
    assert.strictEqual(THRESHOLD_RELATED, 0.8);
    assert.ok(THRESHOLD_DUPLICATE > THRESHOLD_RELATED);
  });
});

describe("memory subtypes", () => {
  it("defines subtype lists by kind", () => {
    assert.ok(MEMORY_SUBTYPES.fact.includes("codebase_map"));
    assert.ok(MEMORY_SUBTYPES.summary.includes("session_index"));
    assert.ok(MEMORY_SUBTYPES.summary.includes("episode"));
    assert.ok(MEMORY_SUBTYPES.summary.includes("workstream"));
    assert.deepStrictEqual(MEMORY_SUBTYPES.distilled, ["convention"]);
    assert.deepStrictEqual(MEMORY_SUBTYPES.relation, []);
    assert.ok(MEMORY_SUBTYPES.telemetry.includes("recall_event"));
    assert.ok(MEMORY_SUBTYPES.fact.includes("product_decision"));
    assert.ok(MEMORY_SUBTYPES.fact.includes("product_requirement"));
    assert.ok(MEMORY_SUBTYPES.fact.includes("user_workflow"));
    assert.ok(MEMORY_SUBTYPES.fact.includes("roadmap_item"));
    assert.ok(MEMORY_SUBTYPES.fact.includes("success_metric"));
    assert.ok(MEMORY_SUBTYPES.fact.includes("market_insight"));
    assert.ok(MEMORY_SUBTYPES.fact.includes("person_profile"));
    assert.ok(MEMORY_SUBTYPES.fact.includes("ownership_note"));
    assert.ok(MEMORY_SUBTYPES.fact.includes("working_agreement"));
    assert.ok(MEMORY_SUBTYPES.fact.includes("activity_event"));
    // Removed in taxonomy-slim cleanup:
    assert.ok(!MEMORY_SUBTYPES.fact.includes("deployment_procedure" as never));
    assert.ok(!MEMORY_SUBTYPES.fact.includes("ownership" as never));
    assert.ok(!MEMORY_SUBTYPES.distilled.includes("failure_mode" as never));
  });

  it("validates subtype and kind combinations", () => {
    assert.strictEqual(normalizeMemorySubtype("fact", "codebase_map"), "codebase_map");
    assert.strictEqual(normalizeMemorySubtype("summary", "episode"), "episode");
    assert.strictEqual(normalizeMemorySubtype("fact", "episode"), null);
    assert.strictEqual(validateMemorySubtype("summary", "episode"), "episode");
    assert.throws(() => validateMemorySubtype("fact", "episode"), /Invalid memory_subtype/);
  });

  it("provides deterministic subtype defaults and category/layer hints", () => {
    assert.strictEqual(defaultMemorySubtypeForKind("fact"), "codebase_map");
    assert.strictEqual(defaultMemorySubtypeForKind("relation"), null);
    assert.strictEqual(categoryForMemorySubtype("architecture_decision"), "engineering");
    assert.strictEqual(categoryForMemorySubtype("product_decision"), "product");
    assert.strictEqual(categoryForMemorySubtype("preference"), "human");
    assert.strictEqual(categoryForMemorySubtype("session_index"), "system");
    assert.strictEqual(layerForMemorySubtype("workstream"), "workstream");
    assert.strictEqual(layerForMemorySubtype("episode"), "episode");
    assert.ok(memorySubtypeValues().includes("convention"));
    assert.deepStrictEqual(memorySubtypeValuesForKind("summary"), ["session_index", "episode", "workstream"]);
    assert.deepStrictEqual(memorySubtypeValuesForKind("distilled"), ["convention"]);
  });
});

describe("normalization", () => {
  it("normalizes canonical categories and useful descriptive variants", () => {
    assert.strictEqual(normalizeCategory("Engineering"), "engineering");
    assert.strictEqual(normalizeCategory("Infrastructure"), "engineering");
    assert.strictEqual(normalizeCategory("infra-stuff"), "engineering");
    assert.strictEqual(normalizeCategory("product decision"), "product");
    assert.strictEqual(normalizeCategory("owner"), "human");
    assert.strictEqual(normalizeCategory("preferences"), "human");
    assert.strictEqual(normalizeCategory("workstream"), "system");
    assert.strictEqual(normalizeCategory("something_random"), "engineering");
  });

  it("normalizes canonical domain profiles only", () => {
    assert.strictEqual(normalizeDomain("software-engineering"), "software_engineering");
    assert.strictEqual(normalizeDomain("personal-productivity"), "personal_productivity");
    assert.strictEqual(normalizeDomain("work"), "software_engineering");
    assert.strictEqual(normalizeDomain("personal"), "software_engineering");
    assert.strictEqual(normalizeDomain(undefined), "software_engineering");
    assert.strictEqual(normalizeDomain("unknown"), "software_engineering");
  });

  it("normalizes kind, source, and layer", () => {
    assert.strictEqual(normalizeKind("summarized"), "summary");
    assert.strictEqual(normalizeKind("distillation"), "distilled");
    assert.strictEqual(normalizeKind("edge"), "relation");
    assert.strictEqual(normalizeKind("feedback event"), "telemetry");
    assert.strictEqual(normalizeSource("daemon"), "system");
    assert.strictEqual(normalizeSource("ui"), "user");
    assert.strictEqual(normalizeSource("portal"), "user");
    assert.strictEqual(normalizeSource("cortex"), "agent");
    assert.strictEqual(normalizeSource("user"), "user");
    assert.strictEqual(normalizeSource("unknown"), "agent");
    assert.strictEqual(normalizeLayer("memory-object"), "memory_object");
    assert.strictEqual(normalizeLayer("bad-layer"), null);
  });
});

describe("decay policy", () => {
  it("uses category + domain profile decay values", () => {
    assert.strictEqual(getDecayHalfLife({ category: "engineering", domain: "software_engineering" }), 120);
    assert.strictEqual(getDecayHalfLife({ category: "system", domain: "software_engineering" }), 45);
    assert.strictEqual(getDecayHalfLife({ category: "product", domain: "research" }), 120);
  });

  it("maps legacy category aliases into the four-category ontology", () => {
    assert.strictEqual(normalizeCategory("codebase"), "engineering");
    assert.strictEqual(normalizeCategory("product_domain"), "product");
    assert.strictEqual(normalizeCategory("people"), "human");
    assert.strictEqual(normalizeCategory("observations"), "engineering");
    assert.strictEqual(getDecayHalfLife({ category: "observation", domain: "work" }), 120);
    assert.strictEqual(getDecayHalfLife({ category: "team", domain: "personal" }), 180);
  });

  it("does not decay relation or telemetry objects", () => {
    assert.strictEqual(getDecayHalfLife({ kind: "relation" }), null);
    assert.strictEqual(getDecayHalfLife({ kind: "telemetry" }), null);
  });

  it("falls back to the default half-life for unknown category/profile pairs", () => {
    assert.strictEqual(getDecayHalfLife({ category: "unknown_cat", domain: "unknown_domain" }), DECAY_DEFAULT_HALF_LIFE);
  });
});

describe("QDRANT_INDEXES", () => {
  const indexes = new Map(QDRANT_INDEXES.map((idx) => [idx.field_name, idx.field_schema]));

  it("includes memory ontology query-critical payload indexes", () => {
    assert.strictEqual(indexes.get("category"), "keyword");
    assert.strictEqual(indexes.get("domain"), "keyword");
    assert.strictEqual(indexes.get("kind"), "keyword");
    assert.strictEqual(indexes.get("memory_subtype"), "keyword");
    assert.strictEqual(indexes.get("content_hash"), "keyword");
    assert.strictEqual(indexes.get("entities"), "keyword");
    assert.strictEqual(indexes.get("workspace_id"), "keyword");
    assert.strictEqual(indexes.get("actor_id"), "keyword");
    assert.strictEqual(indexes.get("episode_id"), "keyword");
    assert.strictEqual(indexes.get("workstream_key"), "keyword");
    assert.strictEqual(indexes.get("task_key"), "keyword");
    assert.strictEqual(indexes.get("repo"), "keyword");
    assert.strictEqual(indexes.get("branch"), "keyword");
    assert.strictEqual(indexes.get("review_status"), "keyword");
  });

  it("keeps date and lifecycle indexes used by existing filters", () => {
    assert.strictEqual(indexes.get("created_at"), "datetime");
    assert.strictEqual(indexes.get("updated_at"), "datetime");
    assert.strictEqual(indexes.get("last_seen_at"), "datetime");
    assert.strictEqual(indexes.get("last_reinforced_at"), "datetime");
    assert.strictEqual(indexes.get("last_verified_at"), "datetime");
    assert.strictEqual(indexes.get("superseded"), "bool");
    assert.strictEqual(indexes.get("superseded_by"), "keyword");
    assert.strictEqual(indexes.get("verified"), "bool");
    assert.strictEqual(indexes.get("is_bad_exemplar"), "bool");
  });

  it("indexes relation and entity traversal fields used by graph filters", () => {
    assert.strictEqual(indexes.get("entity_name"), "keyword");
    assert.strictEqual(indexes.get("from_entity"), "keyword");
    assert.strictEqual(indexes.get("to_entity"), "keyword");
    assert.strictEqual(indexes.get("relation_type"), "keyword");
  });
});
