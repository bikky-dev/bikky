import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Destination } from "../config.js";
import type { QualityPoint, QualityRollupDeps } from "./quality-rollups.js";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-quality-rollups-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const { CONFIG_DEFAULTS } = await import("../config.js");
const {
  MAINTENANCE_STATE_PATH,
  readMaintenanceState,
  recordMaintenanceRun,
} = await import("./maintenance-state.js");
const {
  aggregateMemoryQualitySignals,
  buildQualityRollups,
  tick,
} = await import("./quality-rollups.js");

const destination: Destination = {
  name: "work",
  qdrant_url: "https://work.q.test",
  qdrant_api_key: null,
  collection: "work_collection",
};

const personalDestination: Destination = {
  name: "perso",
  qdrant_url: "https://perso.q.test",
  qdrant_api_key: null,
  collection: "perso_collection",
};

const fact = (
  id: string,
  payload: QualityPoint["payload"],
  destinationName = "work",
): QualityPoint => ({
  id,
  destination: destinationName,
  payload: {
    content: `Fact ${id}`,
    category: "engineering",
    domain: "software_engineering",
    kind: "fact",
    entities: ["bikky"],
    confidence: 0.9,
    created_at: "2026-05-06T00:00:00.000Z",
    updated_at: "2026-05-06T00:00:00.000Z",
    last_reinforced_at: "2026-05-06T00:00:00.000Z",
    ...payload,
  },
});

const event = (id: string, payload: QualityPoint["payload"]): QualityPoint => ({
  id,
  destination: "work",
  payload: {
    content: `Event ${id}`,
    category: "system",
    domain: "software_engineering",
    kind: "telemetry",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    entities: [],
    confidence: 1,
    ...payload,
  },
});

describe("daemon/quality-rollups", () => {
  beforeEach(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
  });

  it("aggregates memory quality signals by scope", () => {
    const rollups = buildQualityRollups({
      generatedAt: new Date("2026-05-07T00:00:00.000Z"),
      staleThresholdDays: 30,
      lowConfidenceThreshold: 0.6,
      facts: [
        fact("fact-1", {
          repo: "bikky-dev/bikky",
          workstream_key: "e5",
          task_key: "T-E5-01",
          entities: ["bikky", "qdrant"],
          confidence: 0.5,
          recall_count: 3,
          useful_count: 2,
          origin: {
            schema_version: 1,
            user: { type: "user", id: "user:saber", name: "Saber", source: "config" },
            agent: { type: "coding_agent", id: "agent:copilot", name: "Copilot", source: "hostname" },
            interface: "mcp",
            operation: { action: "create" },
          },
        }),
        fact("fact-2", {
          repo: "bikky-dev/bikky",
          entities: ["bikky"],
          last_reinforced_at: "2026-03-01T00:00:00.000Z",
        }),
      ],
      events: [
        event("event-1", {
          memory_subtype: "outcome_event",
          target_fact_id: "fact-1",
          outcome: "misleading",
        }),
        event("event-2", {
          memory_subtype: "outcome_event",
          target_fact_id: "fact-2",
          outcome: "wrong",
        }),
      ],
    });

    const repoRollup = rollups.find((rollup) =>
      rollup.scope_type === "repo" && rollup.scope_value === "bikky-dev/bikky"
    );
    assert.ok(repoRollup);
    assert.equal(repoRollup.active_fact_count, 2);
    assert.equal(repoRollup.recall_count, 3);
    assert.equal(repoRollup.useful_count, 2);
    assert.equal(repoRollup.misleading_count, 1);
    assert.equal(repoRollup.wrong_count, 1);
    assert.equal(repoRollup.stale_count, 1);
    assert.equal(repoRollup.low_confidence_count, 1);
    assert.deepEqual(repoRollup.source_event_ids, ["event-1", "event-2"]);

    const userRollup = rollups.find((rollup) =>
      rollup.scope_type === "origin_user" && rollup.scope_value === "user:saber"
    );
    assert.ok(userRollup);
    assert.equal(userRollup.active_fact_count, 1);
  });

  it("keeps identical scope values isolated by destination", () => {
    const rollups = buildQualityRollups({
      generatedAt: new Date("2026-05-07T00:00:00.000Z"),
      facts: [
        fact("work-fact", {
          repo: "bikky-dev/bikky",
          entities: ["bikky"],
          recall_count: 2,
        }, "work"),
        fact("personal-fact", {
          repo: "bikky-dev/bikky",
          entities: ["bikky"],
          recall_count: 5,
        }, "perso"),
      ],
    });

    const repoRollups = rollups.filter((rollup) =>
      rollup.scope_type === "repo" && rollup.scope_value === "bikky-dev/bikky"
    );
    assert.equal(repoRollups.length, 2);
    assert.deepEqual(
      repoRollups.map((rollup) => [rollup.destination, rollup.active_fact_count, rollup.recall_count]).sort(),
      [
        ["perso", 1, 5],
        ["work", 1, 2],
      ],
    );
  });

  it("uses event signals only when fact counters are absent", () => {
    const rollups = buildQualityRollups({
      generatedAt: new Date("2026-05-07T00:00:00.000Z"),
      facts: [
        fact("counter-fact", {
          repo: "bikky-dev/bikky",
          recall_count: 4,
          useful_count: 2,
        }),
        fact("event-only-fact", {
          repo: "bikky-dev/bikky",
        }),
      ],
      events: [
        event("recall-counter", {
          memory_subtype: "recall_event",
          returned_fact_ids: ["counter-fact"],
        }),
        event("useful-counter", {
          memory_subtype: "feedback_event",
          target_fact_id: "counter-fact",
          feedback_kind: "useful",
        }),
        event("recall-event-only", {
          memory_subtype: "recall_event",
          returned_fact_ids: ["event-only-fact"],
        }),
        event("useful-event-only", {
          memory_subtype: "feedback_event",
          target_fact_id: "event-only-fact",
          feedback_kind: "useful",
        }),
      ],
    });

    const repoRollup = rollups.find((rollup) =>
      rollup.scope_type === "repo" && rollup.scope_value === "bikky-dev/bikky"
    );
    assert.ok(repoRollup);
    assert.equal(repoRollup.recall_count, 5);
    assert.equal(repoRollup.useful_count, 3);
    assert.deepEqual(repoRollup.source_event_ids, ["recall-event-only", "useful-event-only"]);
  });

  it("upserts aggregate_rollup telemetry points", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const deps: QualityRollupDeps = {
      isReady: () => true,
      activeDestinations: () => [destination],
      embed: async () => [0.1, 0.2, 0.3],
      qdrantRequest: async (method, urlPath, body) => {
        if (method === "POST" && urlPath.endsWith("/points/scroll")) {
          const filter = (body as { filter?: { must?: Array<Record<string, unknown>> } }).filter;
          const isTelemetry = filter?.must?.some((condition) =>
            (condition.key === "kind") && (condition.match as { value?: string } | undefined)?.value === "telemetry"
          );
          return {
            result: {
              points: isTelemetry
                ? [
                  {
                    id: "event-1",
                    payload: {
                      kind: "telemetry",
                      memory_subtype: "outcome_event",
                      target_fact_id: "fact-1",
                      outcome: "wrong",
                    },
                  },
                ]
                : [
                  {
                    id: "fact-1",
                    payload: {
                      content: "Bikky stores memories in Qdrant.",
                      category: "engineering",
                      domain: "software_engineering",
                      kind: "fact",
                      entities: ["bikky"],
                      confidence: 0.9,
                      recall_count: 4,
                      useful_count: 1,
                      created_at: "2026-05-06T00:00:00.000Z",
                      updated_at: "2026-05-06T00:00:00.000Z",
                      last_reinforced_at: "2026-05-06T00:00:00.000Z",
                    },
                  },
                ],
              next_page_offset: null,
            },
          };
        }
        if (method === "PUT" && urlPath.endsWith("/points")) {
          upserts.push(body as Record<string, unknown>);
          return { result: { status: "ok" } };
        }
        throw new Error(`unexpected request: ${method} ${urlPath}`);
      },
    };

    const result = await aggregateMemoryQualitySignals({
      ...CONFIG_DEFAULTS,
      identity: {
        ...CONFIG_DEFAULTS.identity,
        user_id: "git:saber:60dc9feaec8b",
        user_name: "Saber",
      },
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        memory_quality_rollups_max_scopes_per_run: 10,
      },
    }, deps);

    assert.equal(result.facts_seen, 1);
    assert.equal(result.events_seen, 1);
    assert.equal(result.rollups_upserted > 0, true);
    assert.equal(upserts.length, result.rollups_upserted);

    const firstPayload = upsertPayloads(upserts)[0];
    assert.equal(firstPayload?.kind, "telemetry");
    assert.equal(firstPayload?.memory_subtype, "aggregate_rollup");
    assert.equal(firstPayload?.origin?.user?.name, "Saber");
    assert.equal(firstPayload?.origin?.user?.source, "config");
    assert.equal(firstPayload?.rollup_type, "latest");
    assert.equal(firstPayload?.active_fact_count, 1);
  });

  it("caps rollup writes per destination", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const deps = depsWithScrollResponses({
      work: {
        facts: [
          scrollFact("fact-1", { repo: "repo-1", entities: ["entity-1"] }),
          scrollFact("fact-2", { repo: "repo-2", entities: ["entity-2"] }),
        ],
        events: [],
      },
    }, upserts);

    const result = await aggregateMemoryQualitySignals({
      ...CONFIG_DEFAULTS,
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        memory_quality_rollups_max_scopes_per_run: 2,
      },
    }, deps);

    assert.equal(result.scopes_capped, true);
    assert.equal(result.rollups_upserted, 2);
    assert.equal(upserts.length, 2);
  });

  it("scrolls and aggregates each destination independently", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const deps = depsWithScrollResponses({
      work: {
        facts: [scrollFact("work-fact", { repo: "bikky-dev/bikky", recall_count: 2 })],
        events: [],
      },
      perso: {
        facts: [scrollFact("personal-fact", { repo: "bikky-dev/bikky", recall_count: 5 })],
        events: [],
      },
    }, upserts, [destination, personalDestination]);

    const result = await aggregateMemoryQualitySignals({
      ...CONFIG_DEFAULTS,
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        memory_quality_rollups_max_scopes_per_run: 10,
      },
    }, deps);

    const payloads = upsertPayloads(upserts);
    const repoRollups = payloads.filter((payload) =>
      payload.scope_type === "repo" && payload.scope_value === "bikky-dev/bikky"
    );
    assert.equal(result.destinations_seen, 2);
    assert.equal(result.facts_seen, 2);
    assert.equal(repoRollups.length, 2);
    assert.deepEqual(
      repoRollups.map((payload) => [payload.origin?.metadata?.destination, payload.recall_count]).sort(),
      [
        ["perso", 5],
        ["work", 2],
      ],
    );
  });

  it("does not run tick when disabled, unready, or inside the maintenance interval", async () => {
    let requests = 0;
    const deps: QualityRollupDeps = {
      isReady: () => true,
      activeDestinations: () => [destination],
      embed: async () => [0.1, 0.2, 0.3],
      qdrantRequest: async () => {
        requests++;
        return { result: { points: [], next_page_offset: null } };
      },
    };

    await tick({
      ...CONFIG_DEFAULTS,
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        memory_quality_rollups_enabled: false,
        memory_quality_rollups_interval_sec: 0,
      },
    }, deps);
    assert.equal(requests, 0);

    await tick({
      ...CONFIG_DEFAULTS,
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        memory_quality_rollups_interval_sec: 0,
      },
    }, { ...deps, isReady: () => false });
    assert.equal(requests, 0);

    recordMaintenanceRun("memory_quality_rollups", {
      job: "memory_quality_rollups",
      ran_at: new Date().toISOString(),
      status: "success",
      candidates_seen: 1,
      llm_calls: 0,
      accepted: 1,
    });
    await tick({
      ...CONFIG_DEFAULTS,
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        memory_quality_rollups_interval_sec: 3600,
      },
    }, deps);
    assert.equal(requests, 0);
  });

  it("records success, capped, skipped, and error summaries from tick", async () => {
    const successUpserts: Array<Record<string, unknown>> = [];
    await tick({
      ...CONFIG_DEFAULTS,
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        memory_quality_rollups_interval_sec: 0,
        memory_quality_rollups_max_scopes_per_run: 1,
      },
    }, depsWithScrollResponses({
      work: {
        facts: [scrollFact("fact-1", { repo: "repo-1", entities: ["entity-1"] })],
        events: [],
      },
    }, successUpserts));

    let state = readMaintenanceState();
    assert.ok(fs.existsSync(MAINTENANCE_STATE_PATH));
    assert.equal(state.jobs.memory_quality_rollups.last_summary?.status, "success");
    assert.equal(state.jobs.memory_quality_rollups.last_summary?.accepted, 1);
    assert.equal(state.jobs.memory_quality_rollups.last_summary?.skipped_reason, "max_scopes_per_run_reached");

    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
    await tick({
      ...CONFIG_DEFAULTS,
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        memory_quality_rollups_interval_sec: 0,
      },
    }, depsWithScrollResponses({
      work: { facts: [], events: [] },
    }, []));

    state = readMaintenanceState();
    assert.equal(state.jobs.memory_quality_rollups.last_summary?.status, "skipped");
    assert.equal(state.jobs.memory_quality_rollups.last_summary?.skipped_reason, "no_active_facts");

    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
    await tick({
      ...CONFIG_DEFAULTS,
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        memory_quality_rollups_interval_sec: 0,
      },
    }, {
      isReady: () => true,
      activeDestinations: () => [destination],
      embed: async () => [0.1, 0.2, 0.3],
      qdrantRequest: async () => {
        throw new Error("qdrant unavailable");
      },
    });

    state = readMaintenanceState();
    assert.equal(state.jobs.memory_quality_rollups.last_summary?.status, "error");
    assert.equal(state.jobs.memory_quality_rollups.last_summary?.error, "qdrant unavailable");
  });
});

const scrollFact = (id: string, payload: QualityPoint["payload"] = {}): { id: string; payload: Record<string, unknown> } => ({
  id,
  payload: {
    content: `Fact ${id}`,
    category: "engineering",
    domain: "software_engineering",
    kind: "fact",
    entities: ["bikky"],
    confidence: 0.9,
    created_at: "2026-05-06T00:00:00.000Z",
    updated_at: "2026-05-06T00:00:00.000Z",
    last_reinforced_at: "2026-05-06T00:00:00.000Z",
    ...payload,
  },
});

const depsWithScrollResponses = (
  responses: Record<string, {
    facts: Array<{ id: string; payload: Record<string, unknown> }>;
    events: Array<{ id: string; payload: Record<string, unknown> }>;
  }>,
  upserts: Array<Record<string, unknown>>,
  destinations: Destination[] = [destination],
): QualityRollupDeps => ({
  isReady: () => true,
  activeDestinations: () => destinations,
  embed: async () => [0.1, 0.2, 0.3],
  qdrantRequest: async (method, urlPath, body, destinationRef) => {
    const destinationName = typeof destinationRef === "string" ? destinationRef : destinationRef?.name ?? "work";
    if (method === "POST" && urlPath.endsWith("/points/scroll")) {
      const filter = (body as { filter?: { must?: Array<Record<string, unknown>> } }).filter;
      const isTelemetry = filter?.must?.some((condition) =>
        (condition.key === "kind") && (condition.match as { value?: string } | undefined)?.value === "telemetry"
      );
      const selected = responses[destinationName] ?? { facts: [], events: [] };
      return {
        result: {
          points: isTelemetry ? selected.events : selected.facts,
          next_page_offset: null,
        },
      };
    }
    if (method === "PUT" && urlPath.endsWith("/points")) {
      upserts.push(body as Record<string, unknown>);
      return { result: { status: "ok" } };
    }
    throw new Error(`unexpected request: ${method} ${urlPath}`);
  },
});

const upsertPayloads = (
  upserts: Array<Record<string, unknown>>,
): Array<Record<string, unknown> & { origin?: { metadata?: Record<string, unknown>; user?: { name?: string; source?: string } } }> => upserts.flatMap((upsert) =>
  ((upsert.points as Array<{ payload: Record<string, unknown> }> | undefined) ?? [])
    .map((point) => point.payload as Record<string, unknown> & { origin?: { metadata?: Record<string, unknown>; user?: { name?: string; source?: string } } }),
);
