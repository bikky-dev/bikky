import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Destination } from "../config.js";
import { QdrantPool } from "./qdrant-pool.js";

const destination = (name: string, overrides: Partial<Destination> = {}): Destination => ({
  name,
  qdrant_url: `https://${name}.qdrant.test`,
  qdrant_api_key: null,
  collection: `${name}-collection`,
  ...overrides,
});

const pool = (destinations: Destination[]): QdrantPool =>
  new QdrantPool(destinations, {
    client: {
      timeout_ms: 100,
      retries: 0,
      retry_base_delay_ms: 1,
    },
  });

describe("QdrantPool", () => {
  it("keeps destination order and collection lookup deterministic", () => {
    const p = pool([destination("perso"), destination("work")]);

    assert.deepEqual(p.names(), ["perso", "work"]);
    assert.deepEqual(p.destinations().map((d) => d.name), ["perso", "work"]);
    assert.equal(p.collection("work"), "work-collection");
    assert.throws(() => p.collection("missing"), /not in the pool/);
    assert.throws(() => p.client("missing"), /Known: perso, work/);
  });

  it("tracks per-destination collection readiness and last errors", async () => {
    const p = pool([destination("ok"), destination("bad")]);
    const okClient = p.client("ok") as unknown as { ensureCollection: () => Promise<void> };
    const badClient = p.client("bad") as unknown as { ensureCollection: () => Promise<void> };
    okClient.ensureCollection = async () => {};
    badClient.ensureCollection = async () => {
      throw new Error("permission denied");
    };

    await p.ensureCollection("ok", 3, []);
    assert.equal(p.isCollectionReady("ok"), true);
    assert.equal(p.lastError("ok"), null);

    await assert.rejects(() => p.ensureCollection("bad", 3, []), /permission denied/);
    assert.equal(p.isCollectionReady("bad"), false);
    assert.equal(p.lastError("bad"), "permission denied");
  });

  it("fanOut returns per-destination errors without short-circuiting", async () => {
    const p = pool([destination("a"), destination("b"), destination("c")]);

    const results = await p.fanOut(async (dest) => {
      if (dest.name === "b") throw new Error("b failed");
      return `${dest.name}:ok`;
    });

    assert.deepEqual(results.map((r) => r.destination.name), ["a", "b", "c"]);
    assert.deepEqual(results.map((r) => r.result), ["a:ok", null, "c:ok"]);
    assert.equal(results[1]?.error?.message, "b failed");
  });

  it("rebuild replaces clients, readiness, and destination set", async () => {
    const p = pool([destination("old")]);
    const oldClient = p.client("old") as unknown as { ensureCollection: () => Promise<void> };
    oldClient.ensureCollection = async () => {};
    await p.ensureCollection("old", 3, []);
    assert.equal(p.isCollectionReady("old"), true);

    p.rebuild([destination("new")]);

    assert.deepEqual(p.names(), ["new"]);
    assert.equal(p.isCollectionReady("old"), false);
    assert.throws(() => p.client("old"), /Known: new/);
    assert.equal(p.collection("new"), "new-collection");
  });
});
