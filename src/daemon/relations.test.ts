import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildChangedCoOccurrenceCandidates, pairKey } from "./relations.js";
import type { QdrantScrollResult } from "./qdrant.js";

const fact = (overrides: Partial<QdrantScrollResult>): QdrantScrollResult => ({
  id: "fact-1",
  content: "Bikky uses Qdrant for memory storage.",
  category: "codebase",
  entities: [],
  confidence: 0.9,
  last_reinforced_at: "2026-04-27T09:00:00.000Z",
  created_at: "2026-04-27T09:00:00.000Z",
  updated_at: "2026-04-27T09:00:00.000Z",
  metadata: {},
  ...overrides,
});

describe("daemon/relations helpers", () => {
  it("uses stable unordered pair keys", () => {
    assert.equal(pairKey("Bikky", "Qdrant"), pairKey("qdrant", "bikky"));
  });

  it("builds changed-fact relation candidates instead of global co-occurrences", () => {
    const candidates = buildChangedCoOccurrenceCandidates([
      fact({ id: "fact-1", entities: ["bikky", "qdrant", "system"] }),
      fact({
        id: "fact-2",
        entities: ["qdrant", "bikky"],
        updated_at: "2026-04-27T09:10:00.000Z",
      }),
    ]);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.entityA, "bikky");
    assert.equal(candidates[0]?.entityB, "qdrant");
    assert.deepEqual(candidates[0]?.triggeringFactIds, ["fact-1", "fact-2"]);
    assert.equal(candidates[0]?.latestUpdatedAt, "2026-04-27T09:10:00.000Z");
  });
});
