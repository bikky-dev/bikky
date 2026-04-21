/**
 * Tests for the taxonomy module — classification axes, decay, staleness.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORIES,
  DOMAINS,
  KINDS,
  SOURCES,
  DECAY_HALF_LIFE,
  DECAY_DEFAULT_HALF_LIFE,
  STALENESS_DAYS,
  THRESHOLD_DUPLICATE,
  THRESHOLD_RELATED,
  QDRANT_INDEXES,
  SOURCE_MIGRATION,
  DEFAULT_DOMAIN,
  DEFAULT_KIND,
  DEFAULT_SOURCE,
  categoryValues,
  domainValues,
  kindValues,
  sourceValues,
  normalizeCategory,
  normalizeDomain,
  normalizeKind,
  normalizeSource,
  getDecayHalfLife,
} from "./taxonomy.js";

// ---------------------------------------------------------------------------
// Value arrays
// ---------------------------------------------------------------------------

describe("categoryValues", () => {
  it("returns array with expected categories", () => {
    const vals = categoryValues();
    assert.ok(Array.isArray(vals));
    assert.ok(vals.includes("infrastructure"));
    assert.ok(vals.includes("decisions"));
    assert.ok(vals.includes("observation"));
    assert.ok(vals.includes("preferences"));
    assert.ok(vals.includes("projects"));
    assert.ok(vals.includes("team"));
  });

  it("has exactly 6 categories", () => {
    assert.strictEqual(categoryValues().length, 6);
  });
});

describe("domainValues", () => {
  it("returns array with work and personal", () => {
    const vals = domainValues();
    assert.ok(vals.includes("work"));
    assert.ok(vals.includes("personal"));
  });

  it("has exactly 2 domains", () => {
    assert.strictEqual(domainValues().length, 2);
  });
});

describe("kindValues", () => {
  it("returns expected kinds", () => {
    const vals = kindValues();
    assert.ok(vals.includes("fact"));
    assert.ok(vals.includes("summary"));
    assert.ok(vals.includes("distilled"));
    assert.ok(vals.includes("relation"));
  });

  it("has exactly 4 kinds", () => {
    assert.strictEqual(kindValues().length, 4);
  });
});

describe("sourceValues", () => {
  it("returns expected sources", () => {
    const vals = sourceValues();
    assert.ok(vals.includes("agent"));
    assert.ok(vals.includes("cortex"));
    assert.ok(vals.includes("system"));
    assert.ok(vals.includes("user"));
    assert.ok(vals.includes("docs"));
  });

  it("has exactly 5 sources", () => {
    assert.strictEqual(sourceValues().length, 5);
  });
});

// ---------------------------------------------------------------------------
// Record objects
// ---------------------------------------------------------------------------

describe("CATEGORIES", () => {
  it("has description and extractionHint for each category", () => {
    for (const [key, def] of Object.entries(CATEGORIES)) {
      assert.ok(def.description, `${key} missing description`);
      assert.ok(def.extractionHint, `${key} missing extractionHint`);
      assert.ok(Array.isArray(def.examples), `${key} missing examples`);
      assert.ok(def.examples.length > 0, `${key} has no examples`);
    }
  });

  it("examples have required fields", () => {
    for (const [key, def] of Object.entries(CATEGORIES)) {
      for (const ex of def.examples) {
        assert.ok(typeof ex.content === "string", `${key} example missing content`);
        assert.ok(Array.isArray(ex.entities), `${key} example missing entities`);
        assert.ok(typeof ex.confidence === "number", `${key} example missing confidence`);
        assert.ok(typeof ex.importance === "number", `${key} example missing importance`);
      }
    }
  });
});

describe("DOMAINS", () => {
  it("has description for each domain", () => {
    for (const [key, def] of Object.entries(DOMAINS)) {
      assert.ok(def.description, `${key} missing description`);
    }
  });
});

describe("KINDS", () => {
  it("has description for each kind", () => {
    for (const [key, def] of Object.entries(KINDS)) {
      assert.ok(def.description, `${key} missing description`);
    }
  });
});

describe("SOURCES", () => {
  it("has description for each source", () => {
    for (const [key, def] of Object.entries(SOURCES)) {
      assert.ok(def.description, `${key} missing description`);
    }
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("defaults", () => {
  it("DEFAULT_DOMAIN is 'work'", () => {
    assert.strictEqual(DEFAULT_DOMAIN, "work");
  });

  it("DEFAULT_KIND is 'fact'", () => {
    assert.strictEqual(DEFAULT_KIND, "fact");
  });

  it("DEFAULT_SOURCE is 'agent'", () => {
    assert.strictEqual(DEFAULT_SOURCE, "agent");
  });
});

// ---------------------------------------------------------------------------
// STALENESS_DAYS
// ---------------------------------------------------------------------------

describe("STALENESS_DAYS", () => {
  it("is a positive number", () => {
    assert.ok(typeof STALENESS_DAYS === "number");
    assert.ok(STALENESS_DAYS > 0);
  });

  it("is 30", () => {
    assert.strictEqual(STALENESS_DAYS, 30);
  });
});

// ---------------------------------------------------------------------------
// DECAY_HALF_LIFE
// ---------------------------------------------------------------------------

describe("DECAY_HALF_LIFE", () => {
  it("has entries for major categories", () => {
    assert.ok("infrastructure" in DECAY_HALF_LIFE);
    assert.ok("projects" in DECAY_HALF_LIFE);
    assert.ok("decisions" in DECAY_HALF_LIFE);
    assert.ok("observation" in DECAY_HALF_LIFE);
    assert.ok("preferences" in DECAY_HALF_LIFE);
    assert.ok("team" in DECAY_HALF_LIFE);
  });

  it("session_summary has null half-life (no decay)", () => {
    assert.strictEqual(DECAY_HALF_LIFE.session_summary, null);
  });

  it("distilled has null half-life (no decay)", () => {
    assert.strictEqual(DECAY_HALF_LIFE.distilled, null);
  });

  it("all numeric values are positive", () => {
    for (const [key, val] of Object.entries(DECAY_HALF_LIFE)) {
      if (val !== null) {
        assert.ok(val > 0, `${key} has non-positive half-life: ${val}`);
      }
    }
  });
});

describe("DECAY_DEFAULT_HALF_LIFE", () => {
  it("is a reasonable positive number", () => {
    assert.ok(typeof DECAY_DEFAULT_HALF_LIFE === "number");
    assert.ok(DECAY_DEFAULT_HALF_LIFE > 0);
    assert.strictEqual(DECAY_DEFAULT_HALF_LIFE, 90);
  });
});

// ---------------------------------------------------------------------------
// getDecayHalfLife
// ---------------------------------------------------------------------------

describe("getDecayHalfLife", () => {
  it("returns null for summary kind (no decay)", () => {
    assert.strictEqual(getDecayHalfLife({ kind: "summary" }), null);
  });

  it("returns null for distilled kind (no decay)", () => {
    assert.strictEqual(getDecayHalfLife({ kind: "distilled" }), null);
  });

  it("returns 180 for relation kind", () => {
    assert.strictEqual(getDecayHalfLife({ kind: "relation" }), 180);
  });

  it("returns specific value for category+domain combo", () => {
    assert.strictEqual(getDecayHalfLife({ category: "observation", domain: "work" }), 45);
    assert.strictEqual(getDecayHalfLife({ category: "observation", domain: "personal" }), 180);
    assert.strictEqual(getDecayHalfLife({ category: "infrastructure", domain: "work" }), 60);
  });

  it("returns wildcard category value when domain match not found", () => {
    assert.strictEqual(getDecayHalfLife({ category: "decisions", domain: "work" }), 120);
    assert.strictEqual(getDecayHalfLife({ category: "decisions", domain: "personal" }), 120);
  });

  it("returns default when no match", () => {
    assert.strictEqual(getDecayHalfLife({ category: "unknown_cat" }), DECAY_DEFAULT_HALF_LIFE);
  });

  it("returns default with no args", () => {
    // defaults to category=observation, domain=work → 45
    assert.strictEqual(getDecayHalfLife(), 45);
  });
});

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

describe("thresholds", () => {
  it("THRESHOLD_DUPLICATE is between 0 and 1", () => {
    assert.ok(THRESHOLD_DUPLICATE > 0 && THRESHOLD_DUPLICATE < 1);
    assert.strictEqual(THRESHOLD_DUPLICATE, 0.92);
  });

  it("THRESHOLD_RELATED is between 0 and 1", () => {
    assert.ok(THRESHOLD_RELATED > 0 && THRESHOLD_RELATED < 1);
    assert.strictEqual(THRESHOLD_RELATED, 0.80);
  });

  it("THRESHOLD_DUPLICATE > THRESHOLD_RELATED", () => {
    assert.ok(THRESHOLD_DUPLICATE > THRESHOLD_RELATED);
  });
});

// ---------------------------------------------------------------------------
// QDRANT_INDEXES
// ---------------------------------------------------------------------------

describe("QDRANT_INDEXES", () => {
  it("is a non-empty array", () => {
    assert.ok(Array.isArray(QDRANT_INDEXES));
    assert.ok(QDRANT_INDEXES.length > 0);
  });

  it("each index has field_name and field_schema", () => {
    for (const idx of QDRANT_INDEXES) {
      assert.ok(typeof idx.field_name === "string");
      assert.ok(typeof idx.field_schema === "string");
    }
  });

  it("includes key payload indexes", () => {
    const fieldNames = QDRANT_INDEXES.map((i) => i.field_name);
    assert.ok(fieldNames.includes("category"));
    assert.ok(fieldNames.includes("domain"));
    assert.ok(fieldNames.includes("kind"));
    assert.ok(fieldNames.includes("source"));
    assert.ok(fieldNames.includes("entities"));
    assert.ok(fieldNames.includes("content_hash"));
    assert.ok(fieldNames.includes("superseded_by"));
  });
});

// ---------------------------------------------------------------------------
// SOURCE_MIGRATION
// ---------------------------------------------------------------------------

describe("SOURCE_MIGRATION", () => {
  it("maps old source values to new ones", () => {
    assert.strictEqual(SOURCE_MIGRATION.conversation, "agent");
    assert.strictEqual(SOURCE_MIGRATION.task, "agent");
    assert.strictEqual(SOURCE_MIGRATION.observation, "agent");
    assert.strictEqual(SOURCE_MIGRATION.manual, "user");
    assert.strictEqual(SOURCE_MIGRATION.cortex, "cortex");
  });
});

// ---------------------------------------------------------------------------
// Normalization functions
// ---------------------------------------------------------------------------

describe("normalizeCategory", () => {
  it("returns valid category as-is (lowercase)", () => {
    assert.strictEqual(normalizeCategory("infrastructure"), "infrastructure");
    assert.strictEqual(normalizeCategory("decisions"), "decisions");
    assert.strictEqual(normalizeCategory("team"), "team");
  });

  it("is case-insensitive", () => {
    assert.strictEqual(normalizeCategory("Infrastructure"), "infrastructure");
    assert.strictEqual(normalizeCategory("DECISIONS"), "decisions");
  });

  it("maps 'personal' to 'preferences'", () => {
    assert.strictEqual(normalizeCategory("personal"), "preferences");
  });

  it("maps 'session_summary' to 'projects'", () => {
    assert.strictEqual(normalizeCategory("session_summary"), "projects");
  });

  it("maps 'distilled' to 'observation'", () => {
    assert.strictEqual(normalizeCategory("distilled"), "observation");
  });

  it("maps 'relation' to 'team'", () => {
    assert.strictEqual(normalizeCategory("relation"), "team");
  });

  it("fuzzy matches 'infra' to 'infrastructure'", () => {
    assert.strictEqual(normalizeCategory("infra-stuff"), "infrastructure");
  });

  it("fuzzy matches 'decision' to 'decisions'", () => {
    assert.strictEqual(normalizeCategory("a decision"), "decisions");
  });

  it("defaults to 'observation' for unknown", () => {
    assert.strictEqual(normalizeCategory("something_random"), "observation");
  });
});

describe("normalizeDomain", () => {
  it("returns valid domains as-is", () => {
    assert.strictEqual(normalizeDomain("work"), "work");
    assert.strictEqual(normalizeDomain("personal"), "personal");
  });

  it("defaults to 'work' for undefined", () => {
    assert.strictEqual(normalizeDomain(undefined), "work");
  });

  it("defaults to 'work' for unknown values", () => {
    assert.strictEqual(normalizeDomain("unknown"), "work");
  });

  it("fuzzy matches 'personal'", () => {
    assert.strictEqual(normalizeDomain("personal-stuff"), "personal");
  });

  it("fuzzy matches 'life' and 'home'", () => {
    assert.strictEqual(normalizeDomain("life"), "personal");
    assert.strictEqual(normalizeDomain("home"), "personal");
  });
});

describe("normalizeKind", () => {
  it("returns valid kinds as-is", () => {
    assert.strictEqual(normalizeKind("fact"), "fact");
    assert.strictEqual(normalizeKind("summary"), "summary");
    assert.strictEqual(normalizeKind("distilled"), "distilled");
    assert.strictEqual(normalizeKind("relation"), "relation");
  });

  it("defaults to 'fact' for undefined", () => {
    assert.strictEqual(normalizeKind(undefined), "fact");
  });

  it("defaults to 'fact' for unknown", () => {
    assert.strictEqual(normalizeKind("unknown"), "fact");
  });

  it("fuzzy matches partial strings", () => {
    assert.strictEqual(normalizeKind("summarized"), "summary");
    assert.strictEqual(normalizeKind("distillation"), "distilled");
    assert.strictEqual(normalizeKind("relationship"), "relation");
    assert.strictEqual(normalizeKind("edge"), "relation");
  });
});

describe("normalizeSource", () => {
  it("returns valid sources as-is", () => {
    assert.strictEqual(normalizeSource("agent"), "agent");
    assert.strictEqual(normalizeSource("cortex"), "cortex");
    assert.strictEqual(normalizeSource("system"), "system");
    assert.strictEqual(normalizeSource("user"), "user");
    assert.strictEqual(normalizeSource("docs"), "docs");
  });

  it("defaults to 'agent' for undefined", () => {
    assert.strictEqual(normalizeSource(undefined), "agent");
  });

  it("migrates old source values", () => {
    assert.strictEqual(normalizeSource("conversation"), "agent");
    assert.strictEqual(normalizeSource("task"), "agent");
    assert.strictEqual(normalizeSource("observation"), "agent");
    assert.strictEqual(normalizeSource("manual"), "user");
  });

  it("defaults to 'agent' for unknown", () => {
    assert.strictEqual(normalizeSource("unknown"), "agent");
  });
});
