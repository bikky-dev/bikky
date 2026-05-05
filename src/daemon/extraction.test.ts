import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtractedFact } from "./extraction.js";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-extraction-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const {
  DEFAULT_EXTRACTION_PROMPT,
  factQualitySignals,
  isHighQualityExtractedFact,
  normalizeExtractedFact,
  tick,
  setLogger,
} = await import("./extraction.js");
const qdrant = await import("./qdrant.js");
const { initLLM } = await import("../llm/index.js");
const { CONFIG_DEFAULTS, STATE_DIR, loadConfig, saveConfig } = await import("../config.js");

const realFetch = globalThis.fetch;

interface FetchCall {
  destination: string | null;
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function configure(claudeDir: string): void {
  saveConfig({
    ...CONFIG_DEFAULTS,
    destinations: [
      {
        name: "personal",
        qdrant_url: "https://personal.q.test",
        qdrant_api_key: null,
        collection: "personal_collection",
        default: true,
      },
      {
        name: "work",
        qdrant_url: "https://work.q.test",
        qdrant_api_key: null,
        collection: "work_collection",
        match: { content: ["work Qdrant destination"] },
      },
    ],
    embedding: {
      ...CONFIG_DEFAULTS.embedding,
      provider: "ollama",
      base_url: "http://embed.test",
      model: "qwen-test",
      dimensions: 3,
      timeout_ms: 100,
      retries: 0,
    },
    llm: {
      ...CONFIG_DEFAULTS.llm,
      provider: "ollama",
      base_url: "http://llm.test",
      model: "llm-test",
      timeout_ms: 100,
      retries: 0,
    },
    daemon: {
      ...CONFIG_DEFAULTS.daemon,
      extract_every_sec: 1,
      extract_min_events: 2,
    },
    watchers: {
      copilot: { enabled: false, path: path.join(TEST_BIKKY_HOME, "copilot") },
      claude: { enabled: true, path: claudeDir },
    },
    qdrant_client: {
      ...CONFIG_DEFAULTS.qdrant_client,
      timeout_ms: 100,
      retries: 0,
    },
  });
  qdrant.init();
  initLLM({
    config: {
      provider: "ollama",
      baseUrl: "http://llm.test",
      model: "llm-test",
      timeoutMs: 100,
      retries: 0,
    },
    logger: () => {},
  });
}

function installMock(): FetchCall[] {
  const calls: FetchCall[] = [];
  const destinationForUrl = (url: string): string | null => {
    if (url.startsWith("https://personal.q.test/")) return "personal";
    if (url.startsWith("https://work.q.test/")) return "work";
    return null;
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const destination = destinationForUrl(url);
    calls.push({ destination, url, method, body });

    if (url === "http://llm.test/v1/chat/completions") {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              facts: [{
                content: "Claude transcript facts use src/daemon/extraction.ts and route to the work Qdrant destination.",
                category: "engineering",
                memory_subtype: "codebase_map",
                entities: ["bikky", "src/daemon/extraction.ts"],
                confidence: 0.9,
                importance: 0.8,
                quality_score: 0.9,
                confidence_reason: "Explicitly stated in the transcript.",
              }],
            }),
          },
        }],
      }), { status: 200 });
    }

    if (url === "http://embed.test/v1/embeddings") {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
    }

    if (url.endsWith("/points/scroll")) {
      return new Response(JSON.stringify({ result: { points: [] } }), { status: 200 });
    }

    if (url.endsWith("/points/search")) {
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    }

    if (method === "PUT" && url.endsWith("/points")) {
      return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 });
    }

    if (method === "POST" && url.endsWith("/points/payload")) {
      return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 });
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  return calls;
}

function claudeLine(role: "user" | "assistant", content: string): string {
  return JSON.stringify({
    type: role,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content },
  });
}

describe("daemon/extraction prompt", () => {
  it("describes memory ontology fields and avoids legacy domain wording", () => {
    assert.ok(DEFAULT_EXTRACTION_PROMPT.includes("software_engineering"));
    assert.ok(DEFAULT_EXTRACTION_PROMPT.includes("memory_subtype"));
    assert.ok(DEFAULT_EXTRACTION_PROMPT.includes("codebase_map"));
    assert.ok(!DEFAULT_EXTRACTION_PROMPT.includes("work or personal"));
    assert.ok(!DEFAULT_EXTRACTION_PROMPT.includes("Telegram"));
    assert.ok(!DEFAULT_EXTRACTION_PROMPT.includes("WhatsApp"));
    assert.ok(DEFAULT_EXTRACTION_PROMPT.includes("engineering | product | human | system"));
    assert.ok(DEFAULT_EXTRACTION_PROMPT.includes("product_decision"));
    assert.ok(DEFAULT_EXTRACTION_PROMPT.includes("activity_event"));
  });
});

describe("normalizeExtractedFact", () => {
  it("uses canonical category names and assigns subtype metadata", () => {
    const fact = normalizeExtractedFact({
      content: "The root test suite uses Node's built-in test runner; run npm test before opening PRs.",
      category: "people",
      entities: ["Node", "npm-test"],
      confidence: 0.9,
      importance: 0.8,
      quality_score: 0.8,
    });

    assert.ok(fact);
    assert.strictEqual(fact.category, "human");
    assert.strictEqual(fact.memory_subtype, "preference");
    assert.deepStrictEqual(fact.entities, ["node", "npm-test"]);
  });

  it("accepts short durable preferences without padding", () => {
    const fact = normalizeExtractedFact({
      content: "Prefer Node's built-in test runner for daemon unit tests.",
      category: "preferences",
      memory_subtype: "preference",
      entities: ["node-test-runner"],
      confidence: 0.9,
      importance: 0.7,
      quality_score: 0.7,
    });

    assert.ok(fact);
    assert.strictEqual(fact.memory_subtype, "preference");
  });

  it("rejects skinny status-only memories", () => {
    const fact = normalizeExtractedFact({
      content: "The tests were fixed and now pass.",
      category: "observations",
      entities: [],
      confidence: 0.9,
      importance: 0.6,
      quality_score: 0.8,
    });

    assert.strictEqual(fact, null);
  });

  it("falls back from invalid subtype to the category default", () => {
    const fact = normalizeExtractedFact({
      content: "If Qdrant order_by fails, create a datetime payload index for the sorted field before retrying.",
      category: "operations",
      memory_subtype: "episode",
      entities: ["qdrant", "order_by"],
      confidence: 0.9,
      importance: 0.8,
      quality_score: 0.8,
    });

    assert.ok(fact);
    assert.strictEqual(fact.memory_subtype, "operational_procedure");
  });

  it("parses durable activity-event metadata", () => {
    const fact = normalizeExtractedFact({
      content: "Saber merged PR #85 after approving the subtype UX changes.",
      category: "human",
      memory_subtype: "activity_event",
      entities: ["saber", "pr-85"],
      confidence: 0.9,
      importance: 0.8,
      quality_score: 0.8,
      action_actor: "Saber",
      action_type: "merged",
      action_object: "PR #85",
      action_outcome: "Subtype UX copy changes were approved and merged.",
    });

    assert.ok(fact);
    assert.strictEqual(fact.category, "human");
    assert.strictEqual(fact.memory_subtype, "activity_event");
    assert.strictEqual(fact.action_actor, "Saber");
    assert.strictEqual(fact.action_type, "merged");
    assert.strictEqual(fact.action_object, "PR #85");
    assert.strictEqual(fact.action_outcome, "Subtype UX copy changes were approved and merged.");
  });
});

describe("isHighQualityExtractedFact", () => {
  function makeFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
    return {
      content: "The UI smoke tests live in packages/ui/tests/smoke.spec.ts and run with npm run test:e2e.",
      category: "engineering",
      memory_subtype: "codebase_map",
      entities: ["packages/ui", "playwright"],
      confidence: 0.9,
      importance: 0.7,
      quality_score: 0.8,
      ...overrides,
    };
  }

  it("accepts facts with durable anchors", () => {
    assert.strictEqual(isHighQualityExtractedFact(makeFact()), true);
    const signals = factQualitySignals(makeFact());
    assert.strictEqual(signals.hasDurableAnchor, true);
    assert.strictEqual(signals.isStatusOnly, false);
  });

  it("rejects low-confidence, low-importance weak facts", () => {
    assert.strictEqual(isHighQualityExtractedFact(makeFact({
      content: "There may be something useful about the project.",
      entities: [],
      confidence: 0.4,
      importance: 0.4,
      quality_score: 0.9,
    })), false);
  });

  it("requires either an anchor or short-useful subtype", () => {
    assert.strictEqual(isHighQualityExtractedFact(makeFact({
      content: "The project has a couple of things to remember for later reference.",
      entities: [],
      memory_subtype: "codebase_map",
      confidence: 0.9,
      importance: 0.8,
      quality_score: 0.9,
    })), false);
  });
});

describe("normalizeExtractedFact — self-judgment fields (prompt v2026-04-28-1)", () => {
  it("parses subject, subject_specificity, volatility, self_contained, as_of", () => {
    const fact = normalizeExtractedFact({
      content: "The bikky-dev/bikky CI workflow .github/workflows/release.yml builds Docker images and pushes to ECR.",
      category: "engineering",
      memory_subtype: "infra_topology",
      entities: ["bikky-dev/bikky", "ecr"],
      confidence: 0.9,
      importance: 0.8,
      quality_score: 0.85,
      subject: ".github/workflows/release.yml",
      subject_specificity: 0.95,
      volatility: "stable",
      volatility_reason: "CI workflow file location is durable.",
      self_contained: true,
      repo: "bikky-dev/bikky",
    });

    assert.ok(fact);
    assert.strictEqual(fact.subject, ".github/workflows/release.yml");
    assert.strictEqual(fact.subject_specificity, 0.95);
    assert.strictEqual(fact.volatility, "stable");
    assert.strictEqual(fact.volatility_reason, "CI workflow file location is durable.");
    assert.strictEqual(fact.self_contained, true);
    assert.strictEqual(fact.as_of, null);
    assert.strictEqual(fact.repo, "bikky-dev/bikky");
  });

  it("clamps subject_specificity to [0,1] and rejects unknown volatility values", () => {
    const fact = normalizeExtractedFact({
      content: "The dbt-run-cronjob-v100-29617080 cronjob is currently running the old image.",
      category: "engineering",
      memory_subtype: "troubleshooting_gotcha",
      entities: ["dbt-run-cronjob-v100-29617080"],
      confidence: 0.8,
      importance: 0.6,
      quality_score: 0.7,
      subject: "dbt-run-cronjob-v100-29617080",
      subject_specificity: 1.5,
      volatility: "VERY_TRANSIENT",
      self_contained: true,
      as_of: "2026-04-28",
    });

    assert.ok(fact);
    assert.strictEqual(fact.subject_specificity, 1);
    assert.strictEqual(fact.volatility, null, "unknown volatility values normalize to null");
    assert.strictEqual(fact.as_of, "2026-04-28");
  });

  it("ignores malformed as_of and missing self-judgment fields without dropping the fact", () => {
    const fact = normalizeExtractedFact({
      content: "The UI smoke tests live in packages/ui/tests/smoke.spec.ts and run with npm run test:e2e.",
      category: "engineering",
      memory_subtype: "codebase_map",
      entities: ["packages/ui"],
      confidence: 0.9,
      importance: 0.7,
      quality_score: 0.8,
      as_of: "yesterday",
    });

    assert.ok(fact, "fact without self-judgment fields should still be accepted");
    assert.strictEqual(fact.subject, null);
    assert.strictEqual(fact.subject_specificity, null);
    assert.strictEqual(fact.volatility, null);
    assert.strictEqual(fact.self_contained, null);
    assert.strictEqual(fact.as_of, null, "malformed as_of must be dropped");
  });
});

describe("factQualitySignals — self-judgment integration", () => {
  function baseFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
    return {
      content: "The UI smoke tests live in packages/ui/tests/smoke.spec.ts and run with npm run test:e2e.",
      category: "engineering",
      memory_subtype: "codebase_map",
      entities: ["packages/ui"],
      confidence: 0.9,
      importance: 0.7,
      quality_score: 0.8,
      ...overrides,
    };
  }

  it("boosts the quality score when subject_specificity is high", () => {
    const high = factQualitySignals(baseFact({ subject_specificity: 0.95 }));
    const baseline = factQualitySignals(baseFact());
    assert.ok(high.computedQualityScore >= baseline.computedQualityScore);
  });

  it("penalizes the quality score when subject_specificity is very low", () => {
    const low = factQualitySignals(baseFact({ subject_specificity: 0.1 }));
    const baseline = factQualitySignals(baseFact());
    assert.ok(low.computedQualityScore < baseline.computedQualityScore);
  });

  it("penalizes the quality score when self_contained is false", () => {
    const notSelf = factQualitySignals(baseFact({ self_contained: false }));
    const baseline = factQualitySignals(baseFact());
    assert.ok(notSelf.computedQualityScore < baseline.computedQualityScore);
  });
});

describe("daemon extraction tick", () => {
  before(() => {
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
  });

  after(() => {
    globalThis.fetch = realFetch;
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
    setLogger(() => {});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("discovers Claude transcripts, extracts facts, stores them in the routed destination, and advances state", async () => {
    const claudeDir = path.join(TEST_BIKKY_HOME, "claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const eventsPath = path.join(claudeDir, "session-1.jsonl");
    const transcript = [
      claudeLine("user", "hello"),
      claudeLine("assistant", "hi there"),
    ].join("\n") + "\n";
    fs.writeFileSync(eventsPath, transcript, "utf-8");
    configure(claudeDir);
    const calls = installMock();

    await tick(loadConfig());

    const extractionCall = calls.find((call) => call.url === "http://llm.test/v1/chat/completions");
    assert.ok(extractionCall);
    assert.match(JSON.stringify(extractionCall.body), /\[USER\] hello/);

    const upsert = calls.find((call) => call.method === "PUT" && call.url.endsWith("/points"));
    assert.ok(upsert);
    assert.equal(upsert.destination, "work");
    assert.equal(upsert.url, "https://work.q.test/collections/work_collection/points");
    const payload = ((upsert.body?.points as Array<{ payload: Record<string, unknown> }>)[0]!.payload);
    assert.equal(payload.content, "Claude transcript facts use src/daemon/extraction.ts and route to the work Qdrant destination.");
    assert.equal(payload.category, "engineering");
    assert.equal(payload.kind, "fact");
    assert.equal(payload.memory_subtype, "codebase_map");
    assert.equal(payload.source, "system");
    assert.equal((payload.metadata as Record<string, unknown>).extraction_source, "claude");

    const states = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "extraction-state.json"), "utf-8")) as Record<string, {
      byte_offset: number;
      event_count: number;
      source: string;
      events_path: string;
    }>;
    assert.equal(states["claude:session-1"]?.byte_offset, Buffer.byteLength(transcript));
    assert.equal(states["claude:session-1"]?.event_count, 2);
    assert.equal(states["claude:session-1"]?.source, "claude");
    assert.equal(states["claude:session-1"]?.events_path, eventsPath);
  });
});
