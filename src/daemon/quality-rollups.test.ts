import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CONFIG_DEFAULTS, type Destination } from "../config.js";
import {
  aggregateMemoryQualitySignals,
  buildQualityRollups,
  type QualityPoint,
  type QualityRollupDeps,
} from "./quality-rollups.js";

const destination: Destination = {
  name: "work",
  qdrant_url: "https://work.q.test",
  qdrant_api_key: null,
  collection: "work_collection",
};

const fact = (id: string, payload: QualityPoint["payload"]): QualityPoint => ({
  id,
  destination: "work",
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
      daemon: {
        ...CONFIG_DEFAULTS.daemon,
        memory_quality_rollups_max_scopes_per_run: 10,
      },
    }, deps);

    assert.equal(result.facts_seen, 1);
    assert.equal(result.events_seen, 1);
    assert.equal(result.rollups_upserted > 0, true);
    assert.equal(upserts.length, result.rollups_upserted);

    const firstPayload = ((upserts[0]?.points as Array<{ payload: Record<string, unknown> }>)[0]?.payload);
    assert.equal(firstPayload?.kind, "telemetry");
    assert.equal(firstPayload?.memory_subtype, "aggregate_rollup");
    assert.equal(firstPayload?.rollup_type, "latest");
    assert.equal(firstPayload?.active_fact_count, 1);
  });
});
