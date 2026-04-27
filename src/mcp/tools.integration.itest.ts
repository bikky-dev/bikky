/**
 * End-to-end integration test against a real Qdrant Cloud collection.
 *
 * **OPT-IN.** This file uses the `.itest.ts` extension so the default
 * `dist/**\/*.test.js` glob does NOT pick it up. Run explicitly with:
 *
 *   BIKKY_INTEGRATION=1 npm run test:integration
 *
 * Required env (or in ~/.bikky/config.json — loadConfig merges env):
 *   - BIKKY_INTEGRATION=1   (master gate)
 *   - QDRANT_URL            (Qdrant Cloud REST URL)
 *   - QDRANT_API_KEY        (Qdrant Cloud API key)
 *   - embedding provider config (defaults from ~/.bikky/config.json)
 *
 * Behaviour:
 *   - Creates a uuid-suffixed throwaway collection (`bikky-it-<short>`).
 *   - Drops it in `after()` regardless of pass/fail.
 *   - Exercises the real handlers from registerTools() against live Qdrant +
 *     real embeddings — validating filter shapes, payload indexes, vector
 *     dimensions, and the dedup similarity thresholds for real.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { registerTools } from "./tools.js";
import {
  setQdrantUrl,
  setQdrantApiKey,
  setReady,
  setCollection,
  initEmbedding,
  ensureCollection,
  qdrantReq,
} from "./api.js";
import { QDRANT_INDEXES } from "./taxonomy.js";
import { loadConfig } from "../config.js";

const enabled =
  process.env.BIKKY_INTEGRATION === "1" &&
  Boolean(process.env.QDRANT_URL || loadConfig().qdrant_url) &&
  Boolean(process.env.QDRANT_API_KEY || loadConfig().qdrant_api_key);

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface FakeServer {
  tool(name: string, desc: string, schema: unknown, handler: Handler): void;
}

function makeFakeServer(): { server: FakeServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server: FakeServer = {
    tool(name, _desc, _schema, handler) {
      handlers.set(name, handler);
    },
  };
  return { server, handlers };
}

let handlers: Map<string, Handler>;
let collectionName: string;

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? "";
}

async function invoke(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const h = handlers.get(name);
  if (!h) throw new Error(`Handler '${name}' not registered`);
  return h(args);
}

describe("mcp/tools — Qdrant integration", { skip: !enabled }, () => {
  before(async () => {
    const cfg = loadConfig();
    const url = process.env.QDRANT_URL ?? cfg.qdrant_url;
    const apiKey = process.env.QDRANT_API_KEY ?? cfg.qdrant_api_key;
    if (!url || !apiKey) throw new Error("Qdrant URL / API key missing");

    collectionName = `bikky-it-${randomUUID().slice(0, 8)}`;
    setQdrantUrl(url);
    setQdrantApiKey(apiKey);
    setCollection(collectionName);

    initEmbedding({
      provider: cfg.embedding.provider,
      baseUrl: cfg.embedding.base_url,
      model: cfg.embedding.model,
      dimensions: cfg.embedding.dimensions,
      apiKey: cfg.embedding.api_key,
    });

    await ensureCollection(QDRANT_INDEXES);
    setReady(true);

    const fake = makeFakeServer();
    registerTools(fake.server as unknown as Parameters<typeof registerTools>[0]);
    handlers = fake.handlers;
  });

  after(async () => {
    try {
      if (collectionName) {
        await qdrantReq("DELETE", `/collections/${collectionName}`);
      }
    } finally {
      setReady(false);
      setQdrantUrl(null);
      setQdrantApiKey(null);
    }
  });

  // Shared state across the ordered scenarios below.
  let fact1Id: string;
  let fact2Id: string;

  it("inserts two distinct facts", async () => {
    const r1 = JSON.parse(textOf(await invoke("memory_store", {
      content: "Qdrant Cloud free tier provides 1GB storage with no credit card required",
      category: "infrastructure",
      entities: ["qdrant", "qdrant-cloud"],
    })));
    assert.equal(r1.action, "inserted");
    fact1Id = r1.fact_id;

    const r2 = JSON.parse(textOf(await invoke("memory_store", {
      content: "OpenAI text-embedding-3-small produces 1536-dimensional vectors",
      category: "infrastructure",
      entities: ["openai", "embeddings"],
    })));
    assert.equal(r2.action, "inserted");
    fact2Id = r2.fact_id;

    assert.notEqual(fact1Id, fact2Id);
  });

  it("reinforces on exact content-hash match", async () => {
    const r = JSON.parse(textOf(await invoke("memory_store", {
      content: "Qdrant Cloud free tier provides 1GB storage with no credit card required",
      category: "infrastructure",
      entities: ["qdrant"],
    })));
    assert.equal(r.action, "reinforced");
    assert.equal(r.fact_id, fact1Id);
    assert.ok(r.reinforcement_count >= 2);
  });

  it("reinforces on a near-duplicate via real-vector similarity", async () => {
    // Paraphrase of fact 1 — same meaning, different wording.
    const r = JSON.parse(textOf(await invoke("memory_store", {
      content: "Qdrant Cloud's free plan offers 1GB of storage and does not require a credit card",
      category: "infrastructure",
      entities: ["qdrant"],
    })));
    // Either reinforced (preferred — proves the 0.92 threshold) or inserted
    // with a similar_facts entry pointing at fact1 (proves we're at least in
    // the related band). The first case is the strong assertion; we log if it
    // falls through so a maintainer can re-tune thresholds per embedding model.
    if (r.action === "reinforced") {
      assert.equal(r.fact_id, fact1Id);
    } else {
      assert.equal(r.action, "inserted", `unexpected action: ${r.action}`);
      const similar = (r.similar_facts ?? []) as Array<{ id: string; score: number }>;
      const match = similar.find((s) => s.id === fact1Id);
      assert.ok(
        match,
        `expected paraphrase to reinforce or appear in similar_facts; got ${JSON.stringify(r)}`,
      );

      console.warn(`[integration] paraphrase landed in related band (score=${match!.score}) — consider tuning THRESHOLD_DUPLICATE for this embedding model`);
    }
  });

  it("recalls a stored fact via semantic search", async () => {
    const result = await invoke("memory_recall", {
      query: "What does the Qdrant free tier include?",
      limit: 5,
    });
    const text = textOf(result);
    assert.match(text, /1GB|free tier/i);
  });

  it("aggregates facts about an entity", async () => {
    const result = await invoke("memory_entity", { name: "qdrant" });
    const text = textOf(result);
    assert.match(text, /Facts about qdrant/);
    assert.match(text, /1GB|free tier/i);
  });

  it("forgets a fact and excludes it from subsequent recall", async () => {
    const forgetResult = JSON.parse(textOf(await invoke("memory_forget", {
      fact_id: fact2Id,
      reason: "integration-test cleanup",
    })));
    assert.equal(forgetResult.status, "forgotten");

    // Recall something the forgotten fact would have matched.
    const recallResult = await invoke("memory_recall", {
      query: "OpenAI embedding dimensions",
      limit: 10,
    });
    const text = textOf(recallResult);
    // Fact 2 should not appear (it was the only one about embedding dimensions
    // we inserted). A "no matching facts" response is acceptable.
    assert.doesNotMatch(text, /1536-dimensional/);
  });
});
