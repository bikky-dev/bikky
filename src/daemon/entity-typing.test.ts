import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { __test } from "./entity-typing.js";
import type { QdrantScrollResult } from "./qdrant.js";

const fact = (overrides: Partial<QdrantScrollResult>): QdrantScrollResult => ({
  id: "fact-1",
  content: "The code lives in src/index.ts.",
  category: "engineering",
  entities: [],
  confidence: 0.9,
  last_reinforced_at: "2026-04-27T09:00:00.000Z",
  created_at: "2026-04-27T09:00:00.000Z",
  updated_at: "2026-04-27T09:00:00.000Z",
  metadata: {},
  ...overrides,
});

describe("daemon/entity-typing helpers", () => {
  it("classifies obvious entity shapes without an LLM", () => {
    assert.equal(__test.deterministicEntityType("src/daemon/entity-typing.ts")?.type, "file");
    assert.equal(__test.deterministicEntityType("bikky-dev/bikky")?.type, "repo");
    assert.equal(__test.deterministicEntityType("https://qdrant.example")?.type, "service");
    assert.equal(__test.deterministicEntityType("QDRANT_URL")?.type, "artifact");
    assert.equal(__test.deterministicEntityType("kubectl")?.type, "tool");
    assert.equal(__test.deterministicEntityType("staging")?.type, "environment");
  });

  it("builds entity candidates with attribution from changed facts", () => {
    const candidates = __test.buildEntityCandidates([
      fact({
        id: "fact-1",
        entities: ["src/daemon/entity-typing.ts", "bikky-dev/bikky", "system"],
        metadata: { extracted_from_session: "uuid:abc" },
        workstream_key: "daemon-cost",
      }),
      fact({
        id: "fact-2",
        entities: ["src/daemon/entity-typing.ts"],
        updated_at: "2026-04-27T09:05:00.000Z",
        metadata: { extracted_from_session: "uuid:abc" },
        workstream_key: "daemon-cost",
      }),
    ]);

    const fileCandidate = candidates.find((candidate) => candidate.name === "src/daemon/entity-typing.ts");
    assert.ok(fileCandidate);
    assert.deepEqual(fileCandidate.factIds, ["fact-1", "fact-2"]);
    assert.deepEqual(fileCandidate.sessionIds, ["uuid:abc"]);
    assert.deepEqual(fileCandidate.workstreamKeys, ["daemon-cost"]);
    assert.equal(fileCandidate.latestUpdatedAt, "2026-04-27T09:05:00.000Z");
    assert.ok(!candidates.some((candidate) => candidate.name === "system"));
  });
});
