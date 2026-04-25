/**
 * Tests for pure helper functions in the Memory MCP server.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  contentHash,
  daysSince,
  lastActivityDate,
  computeEffectiveConfidence,
  computeFreshnessScore,
  computeReinforcementScore,
  computeCombinedScore,
  isStale,
  buildFilter,
  formatFact,
  MEMORY_RECALL_EXCLUDED_KINDS,
} from "./helpers.js";
import type { FactPayload, QdrantPoint } from "./types.js";

// ---------------------------------------------------------------------------
// Factory helpers for building test payloads
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<FactPayload> = {}): FactPayload {
  return {
    content: "test content",
    category: "infrastructure",
    domain: "work",
    kind: "fact",
    entities: ["test"],
    source: "agent",
    confidence: 0.9,
    importance: 0.5,
    content_hash: "abc123",
    reinforcement_count: 1,
    last_reinforced_at: new Date().toISOString(),
    superseded_by: null,
    superseded_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePoint(overrides: Partial<QdrantPoint> = {}, payloadOverrides: Partial<FactPayload> = {}): QdrantPoint {
  return {
    id: "test-id",
    score: 0.85,
    payload: makePayload(payloadOverrides),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// contentHash
// ---------------------------------------------------------------------------

describe("contentHash", () => {
  it("returns a hex string", () => {
    const hash = contentHash("infrastructure", "some content");
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  it("is deterministic — same input produces same hash", () => {
    const a = contentHash("decisions", "we chose X");
    const b = contentHash("decisions", "we chose X");
    assert.strictEqual(a, b);
  });

  it("is case-insensitive", () => {
    const a = contentHash("infrastructure", "ClickHouse port 8123");
    const b = contentHash("infrastructure", "clickhouse port 8123");
    assert.strictEqual(a, b);
  });

  it("normalizes whitespace", () => {
    const a = contentHash("observation", "hello   world");
    const b = contentHash("observation", "hello world");
    assert.strictEqual(a, b);
  });

  it("trims leading/trailing whitespace", () => {
    const a = contentHash("observation", "  hello world  ");
    const b = contentHash("observation", "hello world");
    assert.strictEqual(a, b);
  });

  it("different categories produce different hashes", () => {
    const a = contentHash("infrastructure", "content");
    const b = contentHash("decisions", "content");
    assert.notStrictEqual(a, b);
  });

  it("different content produces different hashes", () => {
    const a = contentHash("infrastructure", "content A");
    const b = contentHash("infrastructure", "content B");
    assert.notStrictEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// daysSince
// ---------------------------------------------------------------------------

describe("daysSince", () => {
  it("returns Infinity for null", () => {
    assert.strictEqual(daysSince(null), Infinity);
  });

  it("returns Infinity for undefined", () => {
    assert.strictEqual(daysSince(undefined), Infinity);
  });

  it("returns 0 for future dates", () => {
    const future = new Date(Date.now() + 86400000 * 10).toISOString();
    assert.strictEqual(daysSince(future), 0);
  });

  it("returns positive number for past dates", () => {
    const daysAgo10 = new Date(Date.now() - 86400000 * 10).toISOString();
    const result = daysSince(daysAgo10);
    assert.ok(result > 9.9 && result < 10.1);
  });

  it("returns ~0 for now", () => {
    const now = new Date().toISOString();
    const result = daysSince(now);
    assert.ok(result >= 0 && result < 0.01);
  });

  it("returns ~365 for one year ago", () => {
    const oneYearAgo = new Date(Date.now() - 86400000 * 365).toISOString();
    const result = daysSince(oneYearAgo);
    assert.ok(result > 364.9 && result < 365.1);
  });
});

// ---------------------------------------------------------------------------
// lastActivityDate
// ---------------------------------------------------------------------------

describe("lastActivityDate", () => {
  it("returns last_verified_at when present", () => {
    const payload = makePayload({
      last_verified_at: "2025-01-15T00:00:00Z",
      last_reinforced_at: "2025-01-10T00:00:00Z",
      created_at: "2025-01-01T00:00:00Z",
    });
    assert.strictEqual(lastActivityDate(payload), "2025-01-15T00:00:00Z");
  });

  it("falls back to last_reinforced_at when last_verified_at is undefined", () => {
    const payload = makePayload({
      last_verified_at: undefined,
      last_reinforced_at: "2025-01-10T00:00:00Z",
      created_at: "2025-01-01T00:00:00Z",
    });
    assert.strictEqual(lastActivityDate(payload), "2025-01-10T00:00:00Z");
  });

  it("falls back to created_at when both verified and reinforced are undefined", () => {
    // Set last_reinforced_at to empty string — which is falsy for ?? operator? No, it's truthy.
    // We need to actually use a payload where last_reinforced_at is missing.
    const payload: FactPayload = {
      content: "test",
      category: "infrastructure",
      entities: [],
      confidence: 0.9,
      content_hash: "abc",
      reinforcement_count: 1,
      last_reinforced_at: undefined as unknown as string,
      superseded_by: null,
      superseded_at: null,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };
    // Since last_reinforced_at is required in the interface but we're testing the runtime behavior
    // with undefined, the function should fall through to created_at
    const result = lastActivityDate(payload);
    assert.strictEqual(result, "2025-01-01T00:00:00Z");
  });

  it("returns undefined when no dates are present", () => {
    const payload: FactPayload = {
      content: "test",
      category: "infrastructure",
      entities: [],
      confidence: 0.9,
      content_hash: "abc",
      reinforcement_count: 1,
      last_reinforced_at: undefined as unknown as string,
      superseded_by: null,
      superseded_at: null,
      created_at: undefined as unknown as string,
      updated_at: undefined as unknown as string,
    };
    const result = lastActivityDate(payload);
    assert.strictEqual(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// computeEffectiveConfidence
// ---------------------------------------------------------------------------

describe("computeEffectiveConfidence", () => {
  it("returns original confidence for recent facts", () => {
    const payload = makePayload({
      confidence: 0.9,
      last_reinforced_at: new Date().toISOString(),
    });
    const effective = computeEffectiveConfidence(payload);
    assert.strictEqual(effective, 0.9);
  });

  it("decays confidence for old facts", () => {
    const payload = makePayload({
      category: "infrastructure",
      confidence: 0.9,
      last_reinforced_at: new Date(Date.now() - 86400000 * 60).toISOString(), // 60 days ago
      last_verified_at: undefined,
    });
    const effective = computeEffectiveConfidence(payload);
    assert.ok(effective < 0.9);
    assert.ok(effective > 0);
  });

  it("returns ~50% confidence at half-life", () => {
    // infrastructure half-life is 60 days
    const payload = makePayload({
      category: "infrastructure",
      confidence: 1.0,
      last_reinforced_at: new Date(Date.now() - 86400000 * 60).toISOString(),
      last_verified_at: undefined,
    });
    const effective = computeEffectiveConfidence(payload);
    assert.ok(effective >= 0.45 && effective <= 0.55, `Expected ~0.5, got ${effective}`);
  });

  it("different categories have different decay rates", () => {
    const dayOffset = 86400000 * 90; // 90 days
    const pastDate = new Date(Date.now() - dayOffset).toISOString();

    const infraPayload = makePayload({
      category: "infrastructure",
      confidence: 0.9,
      last_reinforced_at: pastDate,
      last_verified_at: undefined,
    });

    const prefsPayload = makePayload({
      category: "preferences",
      confidence: 0.9,
      last_reinforced_at: pastDate,
      last_verified_at: undefined,
    });

    const infraEffective = computeEffectiveConfidence(infraPayload);
    const prefsEffective = computeEffectiveConfidence(prefsPayload);

    // preferences decay slower (half-life 365) than infrastructure (half-life 60)
    assert.ok(
      prefsEffective > infraEffective,
      `preferences (${prefsEffective}) should decay slower than infrastructure (${infraEffective})`,
    );
  });
});

// ---------------------------------------------------------------------------
// computeFreshnessScore
// ---------------------------------------------------------------------------

describe("computeFreshnessScore", () => {
  it("returns 1.0 for facts < 7 days old", () => {
    const payload = makePayload({
      last_reinforced_at: new Date().toISOString(),
    });
    assert.strictEqual(computeFreshnessScore(payload), 1.0);
  });

  it("returns 1.0 at exactly 7 days", () => {
    const payload = makePayload({
      last_reinforced_at: new Date(Date.now() - 86400000 * 7).toISOString(),
      last_verified_at: undefined,
    });
    const score = computeFreshnessScore(payload);
    assert.ok(score >= 0.99 && score <= 1.0, `Expected ~1.0, got ${score}`);
  });

  it("returns 0.3 for facts >= 180 days old", () => {
    const payload = makePayload({
      last_reinforced_at: new Date(Date.now() - 86400000 * 200).toISOString(),
      last_verified_at: undefined,
    });
    assert.strictEqual(computeFreshnessScore(payload), 0.3);
  });

  it("returns value between 0.3 and 1.0 for facts between 7 and 180 days", () => {
    const payload = makePayload({
      last_reinforced_at: new Date(Date.now() - 86400000 * 90).toISOString(),
      last_verified_at: undefined,
    });
    const score = computeFreshnessScore(payload);
    assert.ok(score > 0.3 && score < 1.0, `Expected between 0.3 and 1.0, got ${score}`);
  });
});

// ---------------------------------------------------------------------------
// computeReinforcementScore
// ---------------------------------------------------------------------------

describe("computeReinforcementScore", () => {
  it("returns 0.2 for count=1", () => {
    const payload = makePayload({ reinforcement_count: 1 });
    assert.strictEqual(computeReinforcementScore(payload), 0.2);
  });

  it("returns 1.0 for count>=5", () => {
    const payload = makePayload({ reinforcement_count: 5 });
    assert.strictEqual(computeReinforcementScore(payload), 1.0);
  });

  it("returns 1.0 for count>5", () => {
    const payload = makePayload({ reinforcement_count: 10 });
    assert.strictEqual(computeReinforcementScore(payload), 1.0);
  });

  it("returns 0.6 for count=3", () => {
    const payload = makePayload({ reinforcement_count: 3 });
    assert.strictEqual(computeReinforcementScore(payload), 0.6);
  });
});

// ---------------------------------------------------------------------------
// computeCombinedScore
// ---------------------------------------------------------------------------

describe("computeCombinedScore", () => {
  it("returns a number between 0 and ~1.5", () => {
    const point = makePoint({ score: 0.85 });
    const score = computeCombinedScore(point);
    assert.ok(typeof score === "number");
    assert.ok(score >= 0);
  });

  it("higher vector score produces higher combined score", () => {
    const highScorePoint = makePoint({ score: 0.95 });
    const lowScorePoint = makePoint({ score: 0.5 });
    assert.ok(computeCombinedScore(highScorePoint) > computeCombinedScore(lowScorePoint));
  });

  it("uses importance from payload", () => {
    const highImportance = makePoint({}, { importance: 1.0 });
    const lowImportance = makePoint({}, { importance: 0.0 });
    assert.ok(computeCombinedScore(highImportance) > computeCombinedScore(lowImportance));
  });
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

describe("isStale", () => {
  it("returns false for recent facts", () => {
    const payload = makePayload({
      last_reinforced_at: new Date().toISOString(),
    });
    assert.strictEqual(isStale(payload), false);
  });

  it("returns true for facts older than STALENESS_DAYS", () => {
    const payload = makePayload({
      last_reinforced_at: new Date(Date.now() - 86400000 * 45).toISOString(),
      last_verified_at: undefined,
    });
    assert.strictEqual(isStale(payload), true);
  });

  it("uses last_verified_at when more recent", () => {
    const payload = makePayload({
      last_reinforced_at: new Date(Date.now() - 86400000 * 45).toISOString(), // 45 days ago
      last_verified_at: new Date().toISOString(), // now
    });
    assert.strictEqual(isStale(payload), false);
  });
});

// ---------------------------------------------------------------------------
// buildFilter
// ---------------------------------------------------------------------------

describe("buildFilter", () => {
  it("returns undefined for empty params", () => {
    // Note: excludeSuperseded defaults to true, so we set it to false for this test
    const result = buildFilter({ excludeSuperseded: false });
    assert.strictEqual(result, undefined);
  });

  it("excludes superseded by default", () => {
    const result = buildFilter({});
    assert.ok(result);
    assert.ok(result.must.length >= 1);
    const supersededFilter = result.must.find(
      (c) => c.is_null && c.is_null.key === "superseded_by",
    );
    assert.ok(supersededFilter);
  });

  it("adds category filter", () => {
    const result = buildFilter({ category: "infrastructure" });
    assert.ok(result);
    const catFilter = result.must.find((c) => c.key === "category");
    assert.ok(catFilter);
    assert.deepStrictEqual(catFilter.match, { value: "infrastructure" });
  });

  it("adds domain filter", () => {
    const result = buildFilter({ domain: "software_engineering" });
    assert.ok(result);
    const domFilter = result.must.find((c) => c.key === "domain");
    assert.ok(domFilter);
    assert.deepStrictEqual(domFilter.match, { value: "software_engineering" });
  });

  it("adds kind filter", () => {
    const result = buildFilter({ kind: "summary" });
    assert.ok(result);
    const kindFilter = result.must.find((c) => c.key === "kind");
    assert.ok(kindFilter);
    assert.deepStrictEqual(kindFilter.match, { value: "summary" });
  });

  it("adds workspace filter", () => {
    const result = buildFilter({ workspace_id: "platform" });
    assert.ok(result);
    const workspaceFilter = result.must.find((c) => c.key === "workspace_id");
    assert.ok(workspaceFilter);
    assert.deepStrictEqual(workspaceFilter.match, { value: "platform" });
  });

  it("can include legacy unscoped workspace facts", () => {
    const result = buildFilter({ workspace_id: "default", includeLegacyWorkspace: true });
    assert.ok(result);
    assert.deepStrictEqual(result.should, [
      { key: "workspace_id", match: { value: "default" } },
      { is_empty: { key: "workspace_id" } },
    ]);
  });

  it("can exclude telemetry from recall filters", () => {
    const result = buildFilter({ excludeKinds: ["telemetry"] });
    assert.ok(result);
    assert.deepStrictEqual(result.must_not, [
      { key: "kind", match: { value: "telemetry" } },
    ]);
  });

  it("keeps telemetry excluded from memory recall even when kind is requested", () => {
    const result = buildFilter({ kind: "telemetry", excludeKinds: MEMORY_RECALL_EXCLUDED_KINDS });
    assert.ok(result);
    assert.ok(result.must.some((condition) => condition.key === "kind" && condition.match?.value === "telemetry"));
    assert.deepStrictEqual(result.must_not, [
      { key: "kind", match: { value: "telemetry" } },
    ]);
  });

  it("adds entity filter (lowercased)", () => {
    const result = buildFilter({ entity: "ClickHouse" });
    assert.ok(result);
    const entityFilter = result.must.find((c) => c.key === "entities");
    assert.ok(entityFilter);
    assert.deepStrictEqual(entityFilter.match, { value: "clickhouse" });
  });

  it("adds since filter with range gte", () => {
    const result = buildFilter({ since: "2025-01-01T00:00:00Z" });
    assert.ok(result);
    const dateFilter = result.must.find((c) => c.key === "created_at");
    assert.ok(dateFilter);
    assert.strictEqual(dateFilter.range?.gte, "2025-01-01T00:00:00Z");
  });

  it("adds until filter with range lte", () => {
    const result = buildFilter({ until: "2025-12-31T23:59:59Z" });
    assert.ok(result);
    const dateFilter = result.must.find((c) => c.key === "created_at");
    assert.ok(dateFilter);
    assert.strictEqual(dateFilter.range?.lte, "2025-12-31T23:59:59Z");
  });

  it("combines since and until into a single range", () => {
    const result = buildFilter({
      since: "2025-01-01T00:00:00Z",
      until: "2025-06-01T00:00:00Z",
    });
    assert.ok(result);
    const dateFilter = result.must.find((c) => c.key === "created_at");
    assert.ok(dateFilter);
    assert.strictEqual(dateFilter.range?.gte, "2025-01-01T00:00:00Z");
    assert.strictEqual(dateFilter.range?.lte, "2025-06-01T00:00:00Z");
  });

  it("adds metadata filters", () => {
    const result = buildFilter({
      metadata: { session_id: "abc123", task_slug: "fix-bug" },
    });
    assert.ok(result);
    const sessionFilter = result.must.find((c) => c.key === "metadata.session_id");
    assert.ok(sessionFilter);
    assert.deepStrictEqual(sessionFilter.match, { value: "abc123" });

    const taskFilter = result.must.find((c) => c.key === "metadata.task_slug");
    assert.ok(taskFilter);
    assert.deepStrictEqual(taskFilter.match, { value: "fix-bug" });
  });

  it("combines all filters together", () => {
    const result = buildFilter({
      category: "infrastructure",
      domain: "work",
      kind: "fact",
      workspace_id: "platform",
      entity: "redis",
      since: "2025-01-01T00:00:00Z",
      metadata: { source: "test" },
    });
    assert.ok(result);
    // superseded (default) + category + domain + kind + workspace + entity + since + metadata
    assert.strictEqual(result.must.length, 8);
  });
});

// ---------------------------------------------------------------------------
// formatFact
// ---------------------------------------------------------------------------

describe("formatFact", () => {
  it("includes category and content", () => {
    const point = makePoint({}, { category: "infrastructure", content: "Redis on port 6379" });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("[infrastructure]"));
    assert.ok(formatted.includes("Redis on port 6379"));
  });

  it("includes entities when present", () => {
    const point = makePoint({}, { entities: ["redis", "cache"] });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("entities: redis, cache"));
  });

  it("includes point id", () => {
    const point = makePoint({ id: "my-uuid-123" });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("id: my-uuid-123"));
  });

  it("includes score when present", () => {
    const point = makePoint({ score: 0.856 });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("score: 0.856"));
  });

  it("includes rank when _combinedScore is present", () => {
    const point = makePoint({ _combinedScore: 0.723 });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("rank: 0.723"));
  });

  it("includes domain when not the default domain profile", () => {
    const point = makePoint({}, { domain: "product_strategy" });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("domain: product_strategy"));
  });

  it("does not include the default domain profile", () => {
    const point = makePoint({}, { domain: "software_engineering" });
    const formatted = formatFact(point);
    assert.ok(!formatted.includes("domain:"));
  });

  it("includes ontology routing fields when present", () => {
    const point = makePoint({}, {
      memory_subtype: "episode",
      workstream_key: "task-123",
      episode_id: "session-1:0-10",
    });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("subtype: episode"));
    assert.ok(formatted.includes("workstream: task-123"));
    assert.ok(formatted.includes("episode: session-1:0-10"));
  });

  it("includes kind when not 'fact'", () => {
    const point = makePoint({}, { kind: "summary" });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("kind: summary"));
  });

  it("includes stale emoji for old facts", () => {
    const point = makePoint({}, {
      last_reinforced_at: new Date(Date.now() - 86400000 * 45).toISOString(),
      last_verified_at: undefined,
    });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("🕰️"));
  });

  it("includes metadata when present", () => {
    const point = makePoint({}, { metadata: { session_id: "abc" } });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("metadata:"));
    assert.ok(formatted.includes("session_id=abc"));
  });

  it("includes reinforced count when > 1", () => {
    const point = makePoint({}, { reinforcement_count: 3 });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("reinforced: 3x"));
  });

  it("includes verified count when > 0", () => {
    const point = makePoint({}, { verification_count: 2 });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("verified: 2x"));
  });

  it("includes non-default workspace and redaction metadata", () => {
    const point = makePoint({}, {
      workspace_id: "platform",
      redaction: {
        redacted: true,
        summary: "email:1",
        matches: [{ type: "email", count: 1 }],
      },
    });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("workspace: platform"));
    assert.ok(formatted.includes("redacted: email:1"));
  });

  it("includes feedback counts", () => {
    const point = makePoint({}, { useful_count: 2, not_useful_count: 1 });
    const formatted = formatFact(point);
    assert.ok(formatted.includes("useful: 2x"));
    assert.ok(formatted.includes("not useful: 1x"));
  });
});
