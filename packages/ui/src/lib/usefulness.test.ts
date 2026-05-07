import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compareUsefulness,
  matchesUsefulnessFilter,
  parseUsefulnessFilter,
  usefulnessMetrics,
  wilsonLowerBound,
} from "./usefulness.js";

describe("usefulness", () => {
  it("returns null scores for unrated memories", () => {
    const metrics = usefulnessMetrics({});
    assert.equal(metrics.usefulness_score, null);
    assert.equal(metrics.usefulness_percent, null);
    assert.equal(metrics.usefulness_rated_count, 0);
  });

  it("uses a conservative Wilson score instead of raw useful rate", () => {
    const oneOfOne = wilsonLowerBound(1, 1);
    const tenOfTwelve = wilsonLowerBound(10, 12);
    assert.ok(oneOfOne !== null);
    assert.ok(tenOfTwelve !== null);
    assert.ok(tenOfTwelve > oneOfOne);
  });

  it("normalizes useful and negative signals", () => {
    const metrics = usefulnessMetrics({
      useful_count: 4,
      useful_feedback_count: 99,
      not_useful_feedback_count: 1,
      misleading_count: 2,
      wrong_count: 1,
      irrelevant_count: 1.9,
    });
    assert.equal(metrics.useful_count, 4);
    assert.equal(metrics.not_useful_count, 1);
    assert.equal(metrics.misleading_count, 2);
    assert.equal(metrics.wrong_count, 1);
    assert.equal(metrics.irrelevant_count, 1);
    assert.equal(metrics.usefulness_rated_count, 9);
    assert.equal(metrics.needs_review, true);
  });

  it("matches usefulness filters", () => {
    const positive = usefulnessMetrics({ useful_count: 2 });
    const needsReview = usefulnessMetrics({ useful_count: 1, wrong_count: 1 });
    const noUseful = usefulnessMetrics({ misleading_count: 1 });
    const unrated = usefulnessMetrics({});

    assert.equal(matchesUsefulnessFilter(positive, parseUsefulnessFilter("positive")), true);
    assert.equal(matchesUsefulnessFilter(needsReview, parseUsefulnessFilter("needs_review")), true);
    assert.equal(matchesUsefulnessFilter(noUseful, parseUsefulnessFilter("no_useful")), true);
    assert.equal(matchesUsefulnessFilter(unrated, parseUsefulnessFilter("unrated")), true);
    assert.equal(matchesUsefulnessFilter(positive, parseUsefulnessFilter("unrated")), false);
  });

  it("sorts rated memories by usefulness while leaving unrated last", () => {
    const rows = [
      { ...usefulnessMetrics({}), created_at: "2024-01-04T00:00:00Z", id: "unrated" },
      { ...usefulnessMetrics({ useful_count: 1, wrong_count: 2 }), created_at: "2024-01-03T00:00:00Z", id: "low" },
      { ...usefulnessMetrics({ useful_count: 10, wrong_count: 2 }), created_at: "2024-01-02T00:00:00Z", id: "high" },
    ];

    assert.deepEqual(
      [...rows].sort((a, b) => compareUsefulness(a, b, "usefulness_desc")).map((row) => row.id),
      ["high", "low", "unrated"],
    );
    assert.deepEqual(
      [...rows].sort((a, b) => compareUsefulness(a, b, "usefulness_asc")).map((row) => row.id),
      ["low", "high", "unrated"],
    );
  });
});
