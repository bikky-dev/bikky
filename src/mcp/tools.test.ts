import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-mcp-tools-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const { registerTools } = await import("./tools.js");
const {
  CONFIG_DEFAULTS,
  resetConfig,
  saveConfig,
} = await import("../config.js");
const {
  rebuildPool,
  setReady,
  setSetupError,
} = await import("./api.js");

type ToolHandler = (args?: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function collectTools(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  registerTools({
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer);
  return handlers;
}

function parseToolJson(result: Awaited<ReturnType<ToolHandler>>): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function destinationList(value: "routed" | "all" | string[]): string {
  return Array.isArray(value) ? value.join(",") : value;
}

function configureDestinations(): void {
  saveConfig({
    ...CONFIG_DEFAULTS,
    destinations: [
      {
        name: "perso",
        description: "Personal memories",
        qdrant_url: "https://perso.q.test",
        qdrant_api_key: "perso-key",
        collection: "perso_collection",
        default: true,
      },
      {
        name: "work",
        description: "Work memories",
        qdrant_url: "https://work.q.test",
        qdrant_api_key: "work-key",
        collection: "work_collection",
      },
    ],
    default_search_scope: "all",
    search_scopes: [
      { name: "personal-only", destinations: ["perso"], description: "Only personal memories" },
    ],
  });
  resetConfig();
  rebuildPool();
}

describe("mcp/tools", () => {
  before(() => {
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    configureDestinations();
    setSetupError(null);
    setReady(true);
  });

  it("registers destination-aware memory tools", () => {
    const handlers = collectTools();

    for (const name of [
      "get_setup_status",
      "memory_search_scopes",
      "memory_store",
      "memory_recall",
      "memory_entity",
      "memory_relations",
    ]) {
      assert.equal(handlers.has(name), true, `expected ${name} to be registered`);
    }
  });

  it("reports setup_required before write tools touch storage", async () => {
    setReady(false);
    setSetupError("embedding unavailable");
    const handlers = collectTools();

    const result = await handlers.get("memory_store")!({
      content: "Bikky stores memories in Qdrant.",
      category: "engineering",
      entities: ["bikky"],
      domain: "software_engineering",
      kind: "fact",
      source: "agent",
      confidence: 0.9,
    });

    const body = parseToolJson(result);
    assert.equal(body.status, "setup_required");
    assert.equal(body.ready, false);
    assert.equal(body.setup_error, "embedding unavailable");
  });

  it("lists built-in, destination, and configured search scopes", async () => {
    const handlers = collectTools();

    const result = await handlers.get("memory_search_scopes")!();
    const body = parseToolJson(result) as {
      default_search_scope: string;
      scopes: Array<{ name: string; destinations: "routed" | "all" | string[] }>;
    };

    assert.equal(body.default_search_scope, "all");
    assert.ok(body.scopes.some((scope) => scope.name === "routed"));
    assert.ok(body.scopes.some((scope) => scope.name === "all" && scope.destinations === "all"));
    assert.ok(body.scopes.some((scope) => scope.name === "perso" && destinationList(scope.destinations) === "perso"));
    assert.ok(body.scopes.some((scope) => scope.name === "personal-only" && destinationList(scope.destinations) === "perso"));
  });

  it("rejects ambiguous recall destination and search_scope before embedding", async () => {
    const handlers = collectTools();

    const result = await handlers.get("memory_recall")!({
      query: "bikky routing",
      destination: "perso",
      search_scope: "all",
      limit: 5,
      graph_depth: 0,
      output_format: "json",
    });

    const body = parseToolJson(result);
    assert.equal(result.isError, true);
    assert.equal(body.status, "ambiguous_search_scope");
  });

  it("validates memory_subtype against kind before storing", async () => {
    const handlers = collectTools();

    const result = await handlers.get("memory_store")!({
      content: "Bikky stores memories in Qdrant.",
      category: "engineering",
      entities: ["bikky"],
      domain: "software_engineering",
      kind: "fact",
      memory_subtype: "session_index",
      source: "agent",
      confidence: 0.9,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /memory_subtype/i);
  });
});
