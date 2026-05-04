import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { availableSearchScopes, resolveSearchScope, SearchScopeNotFoundError } from "./search-scope.js";
import type { BikkyConfig, Destination } from "./config.js";

const dst = (name: string, extra: Partial<Destination> = {}): Destination => ({
  name,
  qdrant_url: `https://${name}.example`,
  qdrant_api_key: null,
  collection: "bikky",
  ...extra,
});

const cfg = (extra: Partial<BikkyConfig> = {}): BikkyConfig => ({
  qdrant_url: null,
  qdrant_api_key: null,
  collection: "bikky",
  destinations: [],
  default_search_scope: "routed",
  search_scopes: [],
  aws_profile: null,
  embedding: {
    provider: "ollama",
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    base_url: "http://localhost:11434",
    api_key: null,
    extra: {},
  },
  llm: {
    provider: "ollama",
    model: "qwen2.5:7b",
    base_url: "http://localhost:11434",
    api_key: null,
    fallback_provider: null,
    extra: {},
  },
  daemon: {
    tick_interval_sec: 5,
    extract_every_sec: 300,
    extract_min_events: 10,
    extraction_prompt: null,
    consolidation_enabled: true,
    relation_inference_enabled: true,
    relation_inference_interval_sec: 7200,
    relation_inference_max_pairs_per_run: 3,
    entity_typing_enabled: true,
    entity_typing_interval_sec: 900,
    entity_typing_max_entities_per_run: 5,
    staleness_threshold_days: 30,
  },
  identity: {
    actor_id: null,
    actor_label: null,
  },
  watchers: {
    copilot: { enabled: true, path: "/tmp/copilot" },
    claude: { enabled: true, path: "/tmp/claude" },
  },
  qdrant_client: {
    timeout_ms: 10_000,
    retries: 3,
    retry_base_delay_ms: 250,
  },
  ...extra,
});

describe("search scope resolution", () => {
  it("defaults to routed destination selection", () => {
    const work = dst("work", { match: { entity: ["^work"] } });
    const personal = dst("personal", { default: true });
    const resolved = resolveSearchScope(undefined, cfg(), [work, personal], { entities: ["work-api"] });

    assert.equal(resolved.name, "routed");
    assert.deepEqual(resolved.destinations.map((dest) => dest.name), ["work"]);
  });

  it("uses config default_search_scope when tool input is omitted", () => {
    const work = dst("work");
    const personal = dst("personal");
    const resolved = resolveSearchScope(undefined, cfg({ default_search_scope: ["work", "personal"] }), [work, personal], {});

    assert.equal(resolved.name, "work,personal");
    assert.deepEqual(resolved.destinations.map((dest) => dest.name), ["work", "personal"]);
  });

  it("resolves the built-in all scope to every destination", () => {
    const work = dst("work");
    const personal = dst("personal");
    const resolved = resolveSearchScope("all", cfg(), [work, personal], {});

    assert.equal(resolved.name, "all");
    assert.deepEqual(resolved.destinations.map((dest) => dest.name), ["work", "personal"]);
  });

  it("resolves a single destination scope", () => {
    const work = dst("work", { description: "Work memory." });
    const personal = dst("personal");
    const resolved = resolveSearchScope("work", cfg(), [work, personal], {});

    assert.equal(resolved.name, "work");
    assert.equal(resolved.description, "Work memory.");
    assert.deepEqual(resolved.destinations.map((dest) => dest.name), ["work"]);
  });

  it("resolves comma-separated destination names for MCP string input", () => {
    const work = dst("work");
    const personal = dst("personal");
    const resolved = resolveSearchScope("work, personal", cfg(), [work, personal], {});

    assert.equal(resolved.name, "work,personal");
    assert.deepEqual(resolved.destinations.map((dest) => dest.name), ["work", "personal"]);
  });

  it("resolves configured named scopes", () => {
    const work = dst("work");
    const personal = dst("personal");
    const resolved = resolveSearchScope(
      "broad",
      cfg({
        search_scopes: [{
          name: "broad",
          description: "Search work and personal memories.",
          destinations: ["work", "personal"],
        }],
      }),
      [work, personal],
      {},
    );

    assert.equal(resolved.name, "broad");
    assert.equal(resolved.description, "Search work and personal memories.");
    assert.deepEqual(resolved.destinations.map((dest) => dest.name), ["work", "personal"]);
  });

  it("surfaces built-in, destination, and configured scope descriptions", () => {
    const work = dst("work", { description: "Engineering memory." });
    const scopes = availableSearchScopes(
      cfg({
        default_search_scope: "broad",
        search_scopes: [{
          name: "broad",
          description: "Search all work-relevant stores.",
          destinations: ["work"],
        }],
      }),
      [work],
    );

    assert.deepEqual(scopes.map((scope) => scope.name), ["routed", "all", "work", "broad"]);
    assert.equal(scopes.find((scope) => scope.name === "work")?.description, "Engineering memory.");
    assert.equal(scopes.find((scope) => scope.name === "broad")?.default, true);
  });

  it("throws for unknown scopes with available names", () => {
    assert.throws(
      () => resolveSearchScope("ghost", cfg(), [dst("work")], {}),
      (err) => err instanceof SearchScopeNotFoundError && err.available.includes("work"),
    );
  });
});
