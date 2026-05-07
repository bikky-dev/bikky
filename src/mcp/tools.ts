/**
 * MCP tool definitions for memory.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import crypto from "node:crypto";
import { z } from "zod";
import type { FactPayload, McpToolResult, QdrantFilter, QdrantPoint } from "./types.js";
import {
  STALENESS_DAYS,
  THRESHOLD_DUPLICATE,
  THRESHOLD_RELATED,
  QDRANT_INDEXES,
  categoryValues,
  categoryEnumDescription,
  domainValues,
  domainEnumDescription,
  kindValues,
  kindEnumDescription,
  memorySubtypeValues,
  memorySubtypeEnumDescription,
  DEFAULT_CATEGORY,
  DEFAULT_DOMAIN,
  DEFAULT_KIND,
  categoryForMemorySubtype,
  layerForMemorySubtype,
  normalizeCategory,
  normalizeDomain,
  normalizeKind,
  validateMemorySubtype,
} from "./taxonomy.js";
import {
  contentHash,
  daysSince,
  lastActivityDate,
  computeCombinedScore,
  buildFilter,
  formatFact,
  structuredFact,
  MEMORY_RECALL_EXCLUDED_KINDS,
} from "./helpers.js";
import {
  ready,
  setupError,
  setReady,
  log,
  embed,
  getEmbeddingConfig,
  qdrantReq,
  ensureCollectionsAll,
  qdrantUpsert,
  qdrantSearch,
  qdrantScroll,
  qdrantSetPayload,
  qdrantGetPoints,
  rebuildPool,
  hasPool,
  listDestinations,
  resolveDest,
  findPointById,
} from "./api.js";
import { DestinationNotFoundError, type RoutingInput } from "../routing.js";
import type { Destination } from "../config.js";
import { saveConfig, loadConfig, EXTRACTION_HEALTH_PATH } from "../config.js";
import {
  availableSearchScopes,
  resolveSearchScope,
  SearchScopeNotFoundError,
  type ResolvedSearchScope,
  type SearchScopeInput,
} from "../search-scope.js";
import { existsSync, readFileSync } from "node:fs";
import { inspectWatcherPaths, formatIssue, repairSuspiciousWatcherPaths } from "../daemon/watcher-health.js";
import { buildOperationOrigin, type OperationOrigin, type OriginAction } from "../provenance/origin.js";
import {
  addRedactionPayload,
  combineRedactions,
  redactStorageText,
} from "../privacy/redaction.js";

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const NUDGE_INTERVAL_MS = 10 * 60 * 1000;
const MEMORY_RECALL_DEFAULT_LIMIT = 10;
const MEMORY_RECALL_MAX_LIMIT = 50;
const searchScopeSchema = z.union([z.string(), z.array(z.string())]).optional();
let lastStoreTime = Date.now();
let heartbeatCount = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

// Build a RoutingInput from the standard memory-tool fields.
function routingInput(args: {
  destination?: string;
  content?: string;
  entities?: string[];
  metadata?: Record<string, string>;
}): RoutingInput {
  return {
    destination: args.destination,
    cwd: process.cwd(),
    content: args.content,
    entities: args.entities,
    metadata: args.metadata,
  };
}

// Resolve a destination from a routing input, returning either the destination
// or an MCP error result if the override is invalid / no destinations exist.
function resolveDestOrError(input: RoutingInput): { dest: Destination; error?: never } | { dest?: never; error: McpToolResult } {
  try {
    return { dest: resolveDest(input) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof DestinationNotFoundError) {
      return {
        error: {
          content: [{ type: "text", text: JSON.stringify({
            status: "destination_not_found",
            message: msg,
            available_destinations: listDestinations().map((d) => d.name),
          }, null, 2) }],
          isError: true,
        },
      };
    }
    return {
      error: {
        content: [{ type: "text", text: JSON.stringify({ status: "error", message: msg }, null, 2) }],
        isError: true,
      },
    };
  }
}

type ScopedPoint = QdrantPoint & {
  _destination: Destination;
  _combinedScore?: number;
};

function withDestination(point: QdrantPoint, destination: Destination): ScopedPoint {
  return { ...point, _destination: destination };
}

function structuredScopedFact(point: ScopedPoint): ReturnType<typeof structuredFact> & { destination: string } {
  return {
    ...structuredFact(point),
    destination: point._destination.name,
  };
}

function formatScopedFact(point: ScopedPoint, includeDestination: boolean): string {
  const formatted = formatFact(point);
  return includeDestination ? `[${point._destination.name}] ${formatted}` : formatted;
}

async function recordRecallTelemetry(args: {
  ranked: ScopedPoint[];
  redactedQuery: ReturnType<typeof redactStorageText>;
  searchScope: ResolvedSearchScope;
  searchedDestinations: string[];
  failedDestinations: Array<{ destination: string; error: string }>;
}): Promise<void> {
  const now = nowISO();
  const byDestination = new Map<string, { dest: Destination; points: ScopedPoint[] }>();
  for (const point of args.ranked) {
    const existing = byDestination.get(point._destination.name);
    if (existing) {
      existing.points.push(point);
    } else {
      byDestination.set(point._destination.name, { dest: point._destination, points: [point] });
    }
  }

  for (const { dest, points } of byDestination.values()) {
    const returnedFactIds = points.map((point) => point.id);
    const recallOrigin = mcpOrigin({
      action: "recall",
      tool: "memory_recall",
      metadata: {
        destination: dest.name,
        result_count: points.length,
        search_scope: args.searchScope.name,
      },
    });

    for (const point of points) {
      const currentCount = point.payload.recall_count ?? 0;
      try {
        await qdrantSetPayload(dest, [point.id], {
          recall_count: currentCount + 1,
          last_recalled_at: now,
          updated_at: now,
          last_operation_origin: recallOrigin,
        });
      } catch (e) {
        log("WARN", `Failed to update recall_count for ${point.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const entities = [...new Set(points.flatMap((point) => point.payload.entities ?? []))].slice(0, 25);
    const eventContent = `Recall returned ${points.length} fact(s) from ${dest.name}: ${args.redactedQuery.text}`;
    const redactedEvent = redactStorageText(eventContent);
    const eventPayload: Record<string, unknown> = {
      content: redactedEvent.text,
      category: categoryForMemorySubtype("recall_event") ?? "system",
      domain: "software_engineering",
      kind: "telemetry",
      memory_subtype: "recall_event",
      layer: "memory_object",
      entities,
      origin: recallOrigin,
      confidence: 1.0,
      importance: 0.3,
      content_hash: contentHash("recall_event", `${dest.name}:${returnedFactIds.join(",")}:${now}`),
      recall_query: args.redactedQuery.text,
      returned_fact_ids: returnedFactIds,
      result_count: points.length,
      search_scope: args.searchScope.name,
      searched_destinations: args.searchedDestinations,
      failed_destinations: args.failedDestinations.map((failure) => `${failure.destination}: ${failure.error}`),
      created_at: now,
      updated_at: now,
    };
    addRedactionPayload(eventPayload, redactedEvent);
    try {
      const eventVector = await embed(redactedEvent.text);
      await qdrantUpsert(dest, newId(), eventVector, eventPayload);
    } catch (e) {
      log("WARN", `Failed to record recall_event: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function resolveSearchScopeOrError(args: {
  destination?: string;
  search_scope?: SearchScopeInput;
  input: RoutingInput;
}): { scope: ResolvedSearchScope; error?: never } | { scope?: never; error: McpToolResult } {
  if (args.destination && args.search_scope !== undefined) {
    return {
      error: {
        content: [{ type: "text", text: JSON.stringify({
          status: "ambiguous_search_scope",
          message: "Use either destination for a single destination override or search_scope for routed/all/list search, not both.",
        }, null, 2) }],
        isError: true,
      },
    };
  }

  if (args.destination) {
    const resolved = resolveDestOrError({ ...args.input, destination: args.destination });
    if (resolved.error) return { error: resolved.error };
    return {
      scope: {
        name: resolved.dest.name,
        description: resolved.dest.description ?? `Search only the '${resolved.dest.name}' destination.`,
        requested: resolved.dest.name,
        destinations: [resolved.dest],
      },
    };
  }

  const cfg = loadConfig();
  const dests = listDestinations();
  try {
    return { scope: resolveSearchScope(args.search_scope, cfg, dests, args.input) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      error: {
        content: [{ type: "text", text: JSON.stringify({
          status: e instanceof SearchScopeNotFoundError ? "search_scope_not_found" : "search_scope_error",
          message: msg,
          available_search_scopes: availableSearchScopes(cfg, dests),
        }, null, 2) }],
        isError: true,
      },
    };
  }
}

function mcpOrigin(input: {
  action: OriginAction;
  tool: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
}): OperationOrigin {
  return buildOperationOrigin({
    interface: "mcp",
    agentType: "coding_agent",
    action: input.action,
    tool: input.tool,
    outcome: input.outcome,
    config: loadConfig(),
    cwd: process.cwd(),
    metadata: input.metadata,
  });
}

async function getPointForWrite(dest: Destination, factId: string): Promise<{ point?: QdrantPoint; error?: Record<string, unknown> }> {
  const existing = await qdrantGetPoints(dest, [factId]);
  const point = existing.result?.[0];
  if (!point) {
    return { error: { status: "not_found", fact_id: factId } };
  }
  return { point };
}

// Locate which destination owns a fact ID (fan-out across pool). Used by
// ID-based ops where the caller doesn't know upfront which destination holds
// the point (memory_forget, memory_verify, memory_report_outcome, etc.).
async function locatePoint(factId: string): Promise<{ dest: Destination; point: QdrantPoint } | null> {
  const found = await findPointById(factId);
  if (!found) return null;
  return { dest: found.destination, point: found.point };
}

function notFoundResult(factId: string): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "not_found", fact_id: factId }, null, 2) }],
    isError: true,
  };
}

function requireReady(): McpToolResult | null {
  if (!ready) {
    const missing: string[] = [];
    if (!hasPool()) missing.push("destinations");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "setup_required",
          ready: false,
          missing,
          ...(setupError ? { setup_error: setupError } : {}),
          setup_instructions:
            "Memory is not configured. Run `bikky setup` or call configure_credentials:\n" +
            "1. Go to cloud.qdrant.io → sign up (free tier: 1GB, no credit card)\n" +
            "2. Create a cluster → copy the REST URL and API key\n" +
            "3. Call configure_credentials with Qdrant values",
          next_step: "Call get_setup_status for detailed status, or configure_credentials to set up.",
        }, null, 2),
      }],
    };
  }
  return null;
}

function buildMemoryNudge(): string | null {
  const elapsed = Date.now() - lastStoreTime;
  if (elapsed < NUDGE_INTERVAL_MS) return null;
  const mins = Math.round(elapsed / 60000);
  // Suggest the most likely category to record based on what an engineering
  // session typically produces. The agent picks the best fit.
  return `🧠 Memory nudge: No memory_store calls in ${mins} minutes. ` +
    "Reflect on what's worth persisting:\n" +
    "  • engineering — codebase maps, architecture, infra, ops, troubleshooting?\n" +
    "  • product — requirements, decisions, workflows, roadmap, metrics, market insight?\n" +
    "  • human — preferences, owners, working agreements, durable activity events?\n" +
    "  • system — session, episode, workstream, or quality-rollup memory?\n" +
    "If yes, call memory_store now so future sessions inherit the knowledge.";
}

function clampRecallLimit(limit: number | undefined): number {
  const rawLimit = limit ?? MEMORY_RECALL_DEFAULT_LIMIT;
  const integerLimit = Math.trunc(rawLimit);
  if (!Number.isFinite(integerLimit)) return MEMORY_RECALL_DEFAULT_LIMIT;
  return Math.min(Math.max(integerLimit, 1), MEMORY_RECALL_MAX_LIMIT);
}

interface GraphTraversalResult {
  points: QdrantPoint[];
  error?: string;
}

/**
 * Entity-graph traversal for memory_recall.
 */
async function graphTraversal(dest: Destination, primaryResults: QdrantPoint[], limit: number): Promise<GraphTraversalResult> {
  try {
    const primaryEntities = new Set<string>();
    const primaryIds = new Set<string>();
    for (const r of primaryResults) {
      primaryIds.add(r.id);
      for (const e of (r.payload.entities ?? [])) {
        primaryEntities.add(e.toLowerCase());
      }
    }

    if (primaryEntities.size === 0) return { points: [] };

    const relatedEntities = new Set<string>();
    for (const entity of primaryEntities) {
      const outgoingFilter: QdrantFilter = buildFilter({ excludeKinds: MEMORY_RECALL_EXCLUDED_KINDS }) ?? { must: [] };
      outgoingFilter.must.push({ key: "from_entity", match: { value: entity } });
      const outgoing = await qdrantScroll(dest, outgoingFilter, 10).catch(() => ({ result: { points: [] as QdrantPoint[] } }));

      for (const pt of (outgoing.result?.points ?? [])) {
        if (pt.payload.to_entity) relatedEntities.add(pt.payload.to_entity);
      }

      const incomingFilter: QdrantFilter = buildFilter({ excludeKinds: MEMORY_RECALL_EXCLUDED_KINDS }) ?? { must: [] };
      incomingFilter.must.push({ key: "to_entity", match: { value: entity } });
      const incoming = await qdrantScroll(dest, incomingFilter, 10).catch(() => ({ result: { points: [] as QdrantPoint[] } }));

      for (const pt of (incoming.result?.points ?? [])) {
        if (pt.payload.from_entity) relatedEntities.add(pt.payload.from_entity);
      }
    }

    for (const e of primaryEntities) relatedEntities.delete(e);
    if (relatedEntities.size === 0) return { points: [] };

    const relatedFacts: QdrantPoint[] = [];
    const maxPerEntity = Math.max(2, Math.floor(limit / relatedEntities.size));
    for (const entity of relatedEntities) {
      const filter: QdrantFilter = buildFilter({ excludeKinds: MEMORY_RECALL_EXCLUDED_KINDS }) ?? { must: [] };
      filter.must.push({ key: "entities", match: { value: entity } });
      const result = await qdrantScroll(dest, filter, maxPerEntity).catch(() => ({ result: { points: [] as QdrantPoint[] } }));

      for (const pt of (result.result?.points ?? [])) {
        if (!primaryIds.has(pt.id)) {
          relatedFacts.push(pt);
        }
      }

      if (relatedFacts.length >= limit) break;
    }

    return { points: relatedFacts.slice(0, Math.ceil(limit / 2)) };
  } catch (e) {
    return { points: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(mcp: McpServer): void {

  // ── get_setup_status ────────────────────────────────────────────────────

  mcp.tool(
    "get_setup_status",
    [
      "Check whether the memory system is configured and reachable.",
      "Use this when memory tools return a 'setup_required' error, or once at session start if you're not sure bikky is wired up. Reports which credentials are missing and includes onboarding instructions if anything is incomplete.",
      "Read-only — safe to call any time.",
    ].join(" "),
    {},
    async (): Promise<McpToolResult> => {
      const cfg = loadConfig();
      const dests = listDestinations();
      const status: Record<string, unknown> = {
        ready,
        destinations_configured: dests.length,
        missing: [] as string[],
        embedding_connected: false,
        embedding_provider: getEmbeddingConfig().provider,
        embedding_model: getEmbeddingConfig().model,
        embedding_dimensions: getEmbeddingConfig().dimensions,
        ...(setupError ? { setup_error: setupError } : {}),
      };
      const missing = status["missing"] as string[];
      if (dests.length === 0) missing.push("destinations");

      // Per-destination health
      const destStatus: Array<Record<string, unknown>> = [];
      for (const d of dests) {
        const block: Record<string, unknown> = {
          name: d.name,
          qdrant_url_host: (() => { try { return new URL(d.qdrant_url).host; } catch { return d.qdrant_url; } })(),
          collection: d.collection,
          default: d.default ?? false,
          ...(d.description ? { description: d.description } : {}),
          connected: false,
          collection_exists: false,
        };
        try {
          await qdrantReq<unknown>(d, "GET", "/collections");
          block["connected"] = true;
        } catch (e) {
          block["last_error"] = e instanceof Error ? e.message : String(e);
        }
        try {
          await qdrantReq<unknown>(d, "GET", `/collections/${d.collection}`);
          block["collection_exists"] = true;
        } catch { /* ignore */ }
        destStatus.push(block);
      }
      status["destinations"] = destStatus;
      status["default_search_scope"] = cfg.default_search_scope;
      status["search_scopes"] = availableSearchScopes(cfg, dests);
      status["search_scope_hint"] =
        "Read/search tools accept search_scope: 'routed', 'all', a destination name, a configured scope name, a comma-separated destination list, or an array of destination names. Use destination only when you want an exact single-destination override.";

      try {
        await embed("test");
        status["embedding_connected"] = true;
      } catch { /* ignore */ }

      // Watcher / extraction health (issue #58)
      const warnings: string[] = [];
      try {
        status["watcher_path"] = cfg.watchers.copilot.path;
        status["watcher_paths"] = {
          copilot: cfg.watchers.copilot.path,
          claude: cfg.watchers.claude.path,
        };
        for (const issue of inspectWatcherPaths(cfg)) {
          warnings.push(formatIssue(issue));
        }
      } catch { /* ignore */ }

      try {
        if (existsSync(EXTRACTION_HEALTH_PATH)) {
          const health = JSON.parse(readFileSync(EXTRACTION_HEALTH_PATH, "utf-8")) as {
            last_tick_at?: string;
            last_active_session_at?: string | null;
            active_session_count?: number;
            watcher_path?: string;
            sources?: Record<string, {
              enabled?: boolean;
              watcher_path?: string;
              active_session_count?: number;
              last_active_session_at?: string | null;
            }>;
          };
          status["extraction_last_tick_at"] = health.last_tick_at ?? null;
          status["extraction_last_active_session_at"] = health.last_active_session_at ?? null;
          status["extraction_active_session_count"] = health.active_session_count ?? 0;
          if (health.sources) status["extraction_sources"] = health.sources;
          if (health.last_active_session_at) {
            const hours = (Date.now() - Date.parse(health.last_active_session_at)) / 3_600_000;
            status["extraction_hours_since_active_session"] = Math.round(hours * 10) / 10;
            if (hours > 6) {
              warnings.push(
                `Watcher has not seen any active transcript sources for ${Math.round(hours)}h — ` +
                `check watcher_path (${health.watcher_path ?? "unknown"}) and that the daemon is running.`,
              );
            }
          } else {
            status["extraction_hours_since_active_session"] = null;
            warnings.push("Daemon has never observed an active transcript source — extraction may be stalled.");
          }
        } else {
          status["extraction_last_tick_at"] = null;
          status["extraction_last_active_session_at"] = null;
          status["extraction_hours_since_active_session"] = null;
        }
      } catch { /* ignore */ }
      if (warnings.length > 0) status["warnings"] = warnings;

      if (!status["ready"] && missing.length > 0) {
        status["setup_instructions"] =
          "Run `bikky setup` or guide the user. Pick one Qdrant option:\n" +
          "  • Qdrant Cloud (managed, free tier, 1GB): https://cloud.qdrant.io — copy the REST URL + API key\n" +
          "  • Local Docker: `docker run -p 6333:6333 qdrant/qdrant` → URL `http://localhost:6333` (no API key needed)\n" +
          "  • Self-hosted: any reachable Qdrant; API key only required if QDRANT__SERVICE__API_KEY is set on the server\n" +
          "Then call configure_credentials with the URL (and API key if applicable).";
      }

      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    },
  );

  // ── memory_search_scopes ─────────────────────────────────────────────────

  mcp.tool(
    "memory_search_scopes",
    [
      "List the configured memory search scopes and destination descriptions.",
      "Use this before memory_recall, memory_entity, or memory_relations when multiple destinations exist so you can choose the right search_scope.",
      "Read-only — returns built-in scopes ('routed', 'all'), destination-name scopes, configured named scopes, and the default_search_scope.",
    ].join(" "),
    {},
    async (): Promise<McpToolResult> => {
      const cfg = loadConfig();
      const dests = listDestinations();
      return {
        content: [{ type: "text", text: JSON.stringify({
          default_search_scope: cfg.default_search_scope,
          scopes: availableSearchScopes(cfg, dests),
          usage: {
            search_scope: "Pass one scope name, 'routed', 'all', a destination name, a comma-separated destination list, or an array of destination names.",
            destination: "Use this older parameter only for an exact single-destination override. Do not combine it with search_scope.",
          },
        }, null, 2) }],
      };
    },
  );

  // ── configure_credentials ───────────────────────────────────────────────

  mcp.tool(
    "configure_credentials",
    [
      "Persist Qdrant and embedding credentials to ~/.bikky/config.json and bring the memory system online.",
      "Call this only during onboarding (or when rotating credentials). After it succeeds, the collection is created if missing and embeddings are tested. For day-to-day use, prefer get_setup_status.",
    ].join(" "),
    {
      qdrant_url: z.string().optional().describe("Qdrant REST URL — Qdrant Cloud (https://xxx.cloud.qdrant.io:6333), local Docker (http://localhost:6333), or self-hosted"),
      qdrant_api_key: z.string().optional().describe("Qdrant API key — required for Qdrant Cloud; optional / leave blank for unauthenticated local or self-hosted instances"),
      openai_api_key: z.string().optional().describe("OpenAI API key (for OpenAI embedding/LLM provider)"),
    },
    async ({ qdrant_url, qdrant_api_key, openai_api_key }): Promise<McpToolResult> => {
      const results: Record<string, unknown> = {};
      const cfg = loadConfig();

      if (qdrant_url) {
        const url = qdrant_url.replace(/\/+$/, "");
        cfg.qdrant_url = url;
        results["qdrant_url"] = "stored ✓";
      }

      if (qdrant_api_key) {
        cfg.qdrant_api_key = qdrant_api_key;
        results["qdrant_api_key"] = "stored ✓";
      }

      if (openai_api_key) {
        cfg.embedding.api_key = openai_api_key;
        cfg.llm.api_key = openai_api_key;
        results["openai_api_key"] = "stored ✓";
      }

      const watcherRepairs = repairSuspiciousWatcherPaths(cfg);
      if (watcherRepairs.length > 0) {
        results["watcher_path_repairs"] = watcherRepairs;
      }

      saveConfig(cfg);

      // Rebuild the destination pool from the updated config so the
      // synthesized default destination picks up the new url/key.
      try {
        rebuildPool();
      } catch (e) {
        results["pool_rebuild"] = `error: ${e instanceof Error ? e.message : String(e)}`;
      }

      if (hasPool()) {
        const ensured = await ensureCollectionsAll(QDRANT_INDEXES);
        results["destinations"] = ensured.map((r) => ({
          name: r.destination.name,
          collection: r.destination.collection,
          ok: r.ok,
          ...(r.error ? { error: r.error } : {}),
        }));
      }

      try {
        await embed("memory system test");
        const embCfg = getEmbeddingConfig();
        results["embedding"] = `${embCfg.provider}/${embCfg.model} (${embCfg.dimensions}d) working ✓`;
      } catch (e) {
        results["embedding"] = `error: ${e instanceof Error ? e.message : String(e)}`;
      }

      setReady(hasPool());
      results["ready"] = ready;

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  // ── verify_connection ───────────────────────────────────────────────────

  mcp.tool(
    "verify_connection",
    [
      "Confirm Qdrant is reachable, embeddings work, and the collection exists.",
      "Use this to debug a sudden 'setup_required' or empty-recall after a network blip or credential change. Lighter than configure_credentials — does not write to disk.",
      "Read-only.",
    ].join(" "),
    {},
    async (): Promise<McpToolResult> => {
      const results: Record<string, unknown> = { embedding: false };

      const dests = listDestinations();
      const destResults: Array<Record<string, unknown>> = [];
      for (const d of dests) {
        const block: Record<string, unknown> = {
          name: d.name,
          collection: d.collection,
          qdrant: false,
          collection_exists: false,
        };
        try {
          await qdrantReq<unknown>(d, "GET", "/collections");
          block["qdrant"] = true;
        } catch (e) {
          block["qdrant_error"] = e instanceof Error ? e.message : String(e);
        }
        try {
          await qdrantReq<unknown>(d, "GET", `/collections/${d.collection}`);
          block["collection_exists"] = true;
        } catch { /* ignore */ }
        destResults.push(block);
      }
      results["destinations"] = destResults;

      try {
        await embed("connection test");
        results["embedding"] = true;
      } catch (e) {
        results["embedding_error"] = e instanceof Error ? e.message : String(e);
      }

      const allReady = results["embedding"] === true && destResults.length > 0
        && destResults.every((b) => b["qdrant"] === true && b["collection_exists"] === true);
      results["ready"] = allReady;
      setReady(allReady);

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  // ── memory_store ────────────────────────────────────────────────────────

  mcp.tool(
    "memory_store",
    [
      "Persist one atomic fact to long-term memory.",
      "Call this whenever you learn something a future session would need: a service detail, a decision rationale, a workaround, a user preference, an ownership fact, a task-resume pointer. One fact per call — split compound observations into separate calls.",
      "Dedup is automatic (content hash + vector similarity), so you do NOT need to recall first for deduplication. Recall first only when you intentionally need broader context to decide whether a new fact supersedes an older one. The tool returns one of: inserted (new fact), reinforced (exact or near-duplicate found — counters bumped), or — if there are similar-but-different facts — a list of potential conflicts so you can decide whether to use 'supersedes'.",
      "To create a typed edge between two entities at the same time, set the optional 'relation' field — no separate tool call needed.",
      "Do NOT use for ephemeral state (current cursor, in-flight todo). Use the harness task folder instead.",
    ].join(" "),
    {
      content: z.string().describe(
        "The fact to store. Should be one atomic, self-contained statement (no compound 'A and B') that makes sense out of context.",
      ),
      category: z.enum(categoryValues()).describe(categoryEnumDescription()),
      entities: z.array(z.string()).describe(
        "Lowercase entity names mentioned by this fact (e.g. ['qdrant', 'workspace_id']). Used for entity-scoped recall and graph traversal — keep them short and canonical.",
      ),
      domain: z.enum(domainValues()).default(DEFAULT_DOMAIN).describe(domainEnumDescription()),
      kind: z.enum(kindValues()).default(DEFAULT_KIND).describe(kindEnumDescription()),
      memory_subtype: z.enum(memorySubtypeValues()).optional().describe(memorySubtypeEnumDescription()),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op. Routing now uses destinations — see destination."),
      destination: z.string().optional().describe(
        "Optional destination override. When set, routes to that destination by name. Hard-errors if no such destination exists. Omit to let routing rules in ~/.bikky/config.json decide based on cwd/entities/content/metadata.",
      ),
      episode_id: z.string().optional().describe(
        "Coherent activity-segment ID. Group facts captured during the same coherent task or transcript.",
      ),
      workstream_key: z.string().optional().describe(
        "Durable continuity key for a long-running objective (survives across sessions).",
      ),
      task_key: z.string().optional().describe("Task or issue key (e.g. GitHub issue number, JIRA key)."),
      repo: z.string().optional().describe("Repository or project surface this fact relates to (e.g. 'bikky-dev/bikky')."),
      branch: z.string().optional().describe("Branch or working surface (e.g. 'main', 'feat/x')."),
      review_status: z.enum(["candidate", "reviewed", "approved", "rejected"]).optional().describe(
        "Review lifecycle status. candidate=auto-extracted (daemon), reviewed=human-checked, approved=human-confirmed, rejected=incorrect. Agents normally leave this unset.",
      ),
      confidence: z.number().min(0).max(1).default(0.9).describe(
        "How certain you are this fact is correct (0.0-1.0). Default 0.9. Lower (~0.6) for inferred or unverified facts.",
      ),
      importance: z.number().min(0).max(1).optional().describe(
        "How important this fact is for future recall (0.0-1.0). Defaults to 0.5 if omitted. ≥0.8 surfaces in session briefings.",
      ),
      supersedes: z.string().optional().describe(
        "ID of an existing fact that this one replaces. The old fact is marked superseded and excluded from recall. Use this when a fact is updated; use memory_forget when a fact was simply wrong.",
      ),
      relation: z.object({
        from: z.string().describe("Source entity (lowercase)."),
        type: z.string().describe("Relation type (e.g. 'owns', 'uses', 'decided', 'prefers', 'works-on')."),
        to: z.string().describe("Target entity (lowercase)."),
      }).optional().describe(
        "Optional typed edge between two entities — created in the same call. Use this whenever the fact also expresses a relationship; no separate tool call needed.",
      ),
      metadata: z.record(z.string(), z.string()).optional().describe(
        "Arbitrary key-value metadata. Stored with the fact and exact-match filterable via memory_recall.metadata_filter (all key/value pairs must match — AND logic).",
      ),
    },
    async ({
      content,
      category,
      entities,
      domain,
      kind,
      memory_subtype,
      workspace_id: _workspace_id,
      destination,
      episode_id,
      workstream_key,
      task_key,
      repo,
      branch,
      review_status,
      confidence,
      importance,
      supersedes,
      relation,
      metadata,
    }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      lastStoreTime = Date.now();
      const now = nowISO();
      const resolved = resolveDestOrError(routingInput({
        destination,
        content,
        entities,
        metadata,
      }));
      if (resolved.error) return resolved.error;
      const dest = resolved.dest;
      const normalizedKind = normalizeKind(kind);
      let normalizedSubtype: string | null = null;
      try {
        normalizedSubtype = validateMemorySubtype(normalizedKind, memory_subtype);
      } catch (e) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
      const normalizedCategory = normalizedSubtype
        ? categoryForMemorySubtype(normalizedSubtype) ?? normalizeCategory(category)
        : normalizeCategory(category);
      const normalizedDomain = normalizeDomain(domain);
      const normalizedLayer = normalizedSubtype ? layerForMemorySubtype(normalizedSubtype) : null;
      const redactedContent = redactStorageText(content);
      const redactedEntities = entities.map((entity) => redactStorageText(entity));
      const sanitizedEntities = redactedEntities.map((entity) => entity.text);
      const redactedRelation = relation ? {
        from: redactStorageText(relation.from),
        type: redactStorageText(relation.type),
        to: redactStorageText(relation.to),
      } : null;
      const factRedactionSummary = combineRedactions([
        redactedContent,
        ...redactedEntities,
      ]);
      const relationRedactionSummary = combineRedactions([
        ...(redactedRelation ? [redactedRelation.from, redactedRelation.type, redactedRelation.to] : []),
      ]);
      const redactionSummary = combineRedactions([
        factRedactionSummary,
        relationRedactionSummary,
      ]);
      const hash = contentHash(normalizedCategory, redactedContent.text);
      const normalizedEntities = sanitizedEntities.map((e) => e.toLowerCase());
      const sanitizedRelation = redactedRelation ? {
        from: redactedRelation.from.text,
        type: redactedRelation.type.text,
        to: redactedRelation.to.text,
      } : null;
      const createOrigin = mcpOrigin({
        action: "create",
        tool: "memory_store",
        metadata: {
          destination: dest.name,
          category: normalizedCategory,
          kind: normalizedKind,
          ...(normalizedSubtype ? { memory_subtype: normalizedSubtype } : {}),
          ...(task_key ? { task_key } : {}),
          ...(repo ? { repo } : {}),
          ...(branch ? { branch } : {}),
        },
      });

      // 1. Exact dedup via content hash
      try {
        const hashFilter: QdrantFilter = buildFilter({}) ?? { must: [] };
        hashFilter.must.push({ key: "content_hash", match: { value: hash } });
        const existing = await qdrantScroll(dest, hashFilter, 1);
        const existingPoint = existing.result?.points?.[0];
        if (existingPoint) {
          const point = existingPoint;
          const count = (point.payload.reinforcement_count || 1) + 1;
          await qdrantSetPayload(dest, [point.id], {
            reinforcement_count: count,
            last_reinforced_at: now,
            updated_at: now,
            last_operation_origin: mcpOrigin({
              action: "reinforce",
              tool: "memory_store",
              outcome: "exact_duplicate",
              metadata: { destination: dest.name, fact_id: point.id },
            }),
          });
          return {
            content: [{ type: "text", text: JSON.stringify({
              action: "reinforced",
              fact_id: point.id,
              reinforcement_count: count,
              message: "Exact match found — reinforced existing fact.",
            }) }],
          };
        }
      } catch (e) {
        log("WARN", `Hash dedup check failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 2. Generate embedding
      const vector = await embed(redactedContent.text);

      // 3. Semantic dedup
      let similarFacts: Array<{ id: string; content: string; score: number }> = [];
      let potentialConflicts: Array<{ id: string; content: string; category: string; similarity: number; shared_entities: string[] }> = [];
      try {
        const filter: QdrantFilter = buildFilter({}) ?? { must: [] };
        if (normalizedEntities.length > 0) {
          filter.must.push({ key: "entities", match: { any: normalizedEntities } });
        }

        const results = await qdrantSearch(dest, vector, filter, 3);
        const firstResult = results.result?.[0];
        if (results.result?.length > 0 && firstResult) {
          const topScore = firstResult.score ?? 0;

          if (topScore > THRESHOLD_DUPLICATE) {
            const point = firstResult;
            const count = (point.payload.reinforcement_count || 1) + 1;
            await qdrantSetPayload(dest, [point.id], {
              reinforcement_count: count,
              last_reinforced_at: now,
              updated_at: now,
              last_operation_origin: mcpOrigin({
                action: "reinforce",
                tool: "memory_store",
                outcome: "semantic_duplicate",
                metadata: { destination: dest.name, fact_id: point.id, similarity: topScore },
              }),
            });
            return {
              content: [{ type: "text", text: JSON.stringify({
                action: "reinforced",
                fact_id: point.id,
                reinforcement_count: count,
                similarity: topScore,
                message: "Near-duplicate found (>0.92 similarity) — reinforced existing fact.",
              }) }],
            };
          }

          if (topScore > THRESHOLD_RELATED) {
            similarFacts = results.result
              .filter((r) => (r.score ?? 0) > THRESHOLD_RELATED)
              .map((r) => ({
                id: r.id,
                content: r.payload.content,
                score: r.score ?? 0,
              }));

            const sharedEntityFacts = results.result.filter((r) => {
              const s = r.score ?? 0;
              if (s <= THRESHOLD_RELATED || s > THRESHOLD_DUPLICATE) return false;
              const existingEntities = r.payload.entities ?? [];
              return normalizedEntities.some((e) => existingEntities.includes(e));
            });
            if (sharedEntityFacts.length > 0) {
              potentialConflicts = sharedEntityFacts.map((r) => ({
                id: r.id,
                content: r.payload.content,
                category: r.payload.category,
                similarity: r.score ?? 0,
                shared_entities: normalizedEntities.filter((e) => (r.payload.entities ?? []).includes(e)),
              }));
            }
          }
        }
      } catch (e) {
        log("WARN", `Semantic dedup search failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 4. Generate fact ID
      const factId = newId();

      // 5. Supersede old fact if requested
      if (supersedes) {
        try {
          const existing = await getPointForWrite(dest, supersedes);
          if (existing.error) {
            return { content: [{ type: "text", text: JSON.stringify(existing.error, null, 2) }], isError: true };
          }
          await qdrantSetPayload(dest, [supersedes], {
            superseded_by: factId,
            superseded_at: now,
            updated_at: now,
            last_operation_origin: mcpOrigin({
              action: "supersede",
              tool: "memory_store",
              metadata: { destination: dest.name, new_fact_id: factId },
            }),
          });
        } catch (e) {
          log("WARN", `Failed to supersede ${supersedes}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 6. Insert new fact
      const payload: Record<string, unknown> = {
        content: redactedContent.text,
        category: normalizedCategory,
        domain: normalizedDomain,
        kind: normalizedKind,
        entities: normalizedEntities,
        origin: createOrigin,
        confidence,
        importance: importance ?? 0.5,
        content_hash: hash,
        reinforcement_count: 1,
        last_reinforced_at: now,
        superseded_by: null,
        superseded_at: null,
        created_at: now,
        updated_at: now,
      };
      if (normalizedSubtype) {
        payload["memory_subtype"] = normalizedSubtype;
      }
      if (normalizedLayer) {
        payload["layer"] = normalizedLayer;
      }
      if (episode_id) payload["episode_id"] = episode_id;
      if (workstream_key) payload["workstream_key"] = workstream_key;
      if (task_key) payload["task_key"] = task_key;
      if (repo) payload["repo"] = repo;
      if (branch) payload["branch"] = branch;
      if (metadata && Object.keys(metadata).length > 0) {
        payload["metadata"] = metadata;
      }
      if (review_status) payload["review_status"] = review_status;
      addRedactionPayload(payload, factRedactionSummary);
      await qdrantUpsert(dest, factId, vector, payload);

      // 7. Insert relation point if provided
      let relationId: string | null = null;
      if (sanitizedRelation) {
        relationId = newId();
        const relContent = `${sanitizedRelation.from} ${sanitizedRelation.type} ${sanitizedRelation.to}`;
        const relVector = await embed(relContent);
        const relPayload: Record<string, unknown> = {
          content: relContent,
          category: normalizedCategory,
          domain: normalizedDomain,
          kind: "relation",
          layer: "memory_object",
          entities: [sanitizedRelation.from.toLowerCase(), sanitizedRelation.to.toLowerCase()],
          origin: mcpOrigin({
            action: "create",
            tool: "memory_store",
            metadata: {
              destination: dest.name,
              parent_fact_id: factId,
              relation_type: sanitizedRelation.type.toLowerCase(),
            },
          }),
          confidence,
          content_hash: contentHash("relation", relContent),
          reinforcement_count: 1,
          last_reinforced_at: now,
          superseded_by: null,
          superseded_at: null,
          created_at: now,
          updated_at: now,
          from_entity: sanitizedRelation.from.toLowerCase(),
          relation_type: sanitizedRelation.type.toLowerCase(),
          to_entity: sanitizedRelation.to.toLowerCase(),
        };
        addRedactionPayload(relPayload, relationRedactionSummary);
        await qdrantUpsert(dest, relationId, relVector, relPayload);
      }

      const result: Record<string, unknown> = {
        action: "inserted",
        fact_id: factId,
        destination: dest.name,
        origin: createOrigin,
      };
      if (relationId) result["relation_id"] = relationId;
      if (redactionSummary.redacted) result["redaction"] = redactionSummary;
      if (similarFacts.length > 0) result["similar_facts"] = similarFacts;
      if (potentialConflicts.length > 0) {
        result["potential_conflicts"] = potentialConflicts;
        result["conflict_hint"] =
          "These existing facts cover similar topics with shared entities but different content. " +
          "Consider using `supersedes` to replace outdated ones, or `memory_forget` to retire them.";
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  // ── memory_recall ───────────────────────────────────────────────────────

  mcp.tool(
    "memory_recall",
    [
      "Semantic + filtered search over memory. Returns facts ranked by relevance (vector similarity blended with recency, importance, and reinforcement).",
      "Three main uses:",
      "  1. Session-start briefing — broad query like 'session briefing: user preferences, active projects, recent decisions'.",
      "  2. Per-prompt contextual recall — focused query derived from what the user just asked.",
      "  3. Conflict/replacement check — recall similar facts when you suspect new information may supersede an older fact. Deduplication during memory_store is automatic.",
      "Combine the natural-language query with structured filters (category, domain, entity, date range, metadata) for tighter results.",
      "If you have a known entity name and want everything about it, prefer memory_entity. For 'what does X own/use?' style questions, prefer memory_relations.",
      "When multiple Qdrant destinations are configured, use search_scope to choose 'routed' (routing/default behavior), 'all', a destination name, a configured scope name, a comma-separated destination list, or an array of destination names. Call memory_search_scopes to inspect available scopes and descriptions.",
      `By default output is human-readable text. Use output_format=json for machine-parseable results with separate results and related arrays. Default limit is ${MEMORY_RECALL_DEFAULT_LIMIT}; maximum effective limit is ${MEMORY_RECALL_MAX_LIMIT}.`,
    ].join("\n"),
    {
      query: z.string().describe(
        "Natural-language description of what you're looking for. Embedded and matched semantically — full sentences work better than keyword lists.",
      ),
      category: z.string().optional().describe(
        "Filter by category (same vocabulary as memory_store.category). Optional.",
      ),
      domain: z.string().optional().describe(
        "Filter by domain activity profile (same vocabulary as memory_store.domain). Optional.",
      ),
      kind: z.string().optional().describe(
        "Filter by kind: fact, summary, distilled, relation. Optional. Telemetry is excluded by default.",
      ),
      memory_subtype: z.string().optional().describe(
        "Filter by memory subtype (must be valid for the chosen kind). Optional.",
      ),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op."),
      destination: z.string().optional().describe(
        "Optional legacy single-destination override. Do not combine with search_scope. Prefer search_scope for routed/all/list search.",
      ),
      search_scope: searchScopeSchema.describe(
        "Optional read/search scope. Accepts 'routed', 'all', a destination name, a configured scope name, a comma-separated destination list, or an array of destination names. Omit to use config.default_search_scope.",
      ),
      origin_user_id: z.string().optional().describe(
        "Filter to facts whose creation origin.user.id matches this value. Optional.",
      ),
      origin_agent_id: z.string().optional().describe(
        "Filter to facts whose creation origin.agent.id matches this value. Optional.",
      ),
      origin_interface: z.enum(["mcp", "daemon", "ui", "api", "cli", "system"]).optional().describe(
        "Filter to facts created through this origin interface. Optional.",
      ),
      include_legacy_workspace: z.boolean().optional().describe("[Removed in v0.4.0] No-op."),
      entity: z.string().optional().describe(
        "Restrict to facts mentioning this entity (case-insensitive). For full entity context prefer memory_entity.",
      ),
      episode_id: z.string().optional().describe("Filter by coherent episode ID."),
      workstream_key: z.string().optional().describe("Filter by durable workstream key."),
      task_key: z.string().optional().describe("Filter by task or issue key."),
      repo: z.string().optional().describe("Filter by repository or project surface."),
      branch: z.string().optional().describe("Filter by branch or working surface."),
      review_status: z.string().optional().describe(
        "Filter by review lifecycle status (candidate / reviewed / approved / rejected).",
      ),
      since: z.string().optional().describe("Only facts created on or after this ISO 8601 date or datetime."),
      until: z.string().optional().describe("Only facts created on or before this ISO 8601 date or datetime."),
      limit: z.number().optional().default(MEMORY_RECALL_DEFAULT_LIMIT).describe(
        `Max primary results to return (default ${MEMORY_RECALL_DEFAULT_LIMIT}, maximum ${MEMORY_RECALL_MAX_LIMIT}). Values above the maximum are clamped.`,
      ),
      graph_depth: z.number().optional().default(0).describe(
        "Entity-graph traversal depth. 0 = vector search only (fast, default). 1 = also surface up to ceil(limit / 2) extra 1-hop entity-related facts (slower; use when the user asks 'what's connected to X?'). In JSON output these are returned separately as related.",
      ),
      output_format: z.enum(["text", "json"]).optional().default("text").describe(
        "Response format. text = backward-compatible human-readable lines (default). json = parseable object with query, limit metadata, results, related, counts, and optional nudge.",
      ),
      metadata_filter: z.record(z.string(), z.string()).optional().describe(
        "Exact-match filter on the metadata map stored with each fact. All key/value pairs must match (AND logic).",
      ),
    },
    async ({
      query,
      category,
      domain,
      kind,
      memory_subtype,
      workspace_id: _workspace_id,
      destination,
      search_scope,
      origin_user_id,
      origin_agent_id,
      origin_interface,
      include_legacy_workspace: _include_legacy_workspace,
      entity,
      episode_id,
      workstream_key,
      task_key,
      repo,
      branch,
      review_status,
      since,
      until,
      limit,
      graph_depth,
      output_format,
      metadata_filter,
    }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const requestedLimit = limit ?? MEMORY_RECALL_DEFAULT_LIMIT;
      const effectiveLimit = clampRecallLimit(limit);
      const scopeResolved = resolveSearchScopeOrError({
        destination,
        search_scope,
        input: routingInput({
          content: query,
          entities: entity ? [entity] : [],
          metadata: metadata_filter,
        }),
      });
      if (scopeResolved.error) return scopeResolved.error;
      const searchScope = scopeResolved.scope;
      const redactedQuery = redactStorageText(query);
      const vector = await embed(redactedQuery.text);
      const normalizedKind = kind ? normalizeKind(kind) : undefined;
      let normalizedSubtype: string | undefined;
      if (memory_subtype) {
        try {
          normalizedSubtype = validateMemorySubtype(normalizedKind, memory_subtype) ?? undefined;
        } catch (e) {
          return {
            content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
            isError: true,
          };
        }
      }
      const filter = buildFilter({
        category: category ? normalizeCategory(category) : undefined,
        domain: domain ? normalizeDomain(domain) : undefined,
        kind: normalizedKind,
        memory_subtype: normalizedSubtype,
        origin_user_id,
        origin_agent_id,
        origin_interface,
        entity,
        episode_id,
        workstream_key,
        task_key,
        repo,
        branch,
        review_status,
        since,
        until,
        metadata: metadata_filter,
        excludeKinds: MEMORY_RECALL_EXCLUDED_KINDS,
      });
      const searchedDestinations = searchScope.destinations.map((dest) => dest.name);
      const failedDestinations: Array<{ destination: string; error: string }> = [];
      const scopedResults: ScopedPoint[] = [];
      for (const dest of searchScope.destinations) {
        try {
          const results = await qdrantSearch(dest, vector, filter, effectiveLimit * 2);
          scopedResults.push(...(results.result ?? []).map((point) => withDestination(point, dest)));
        } catch (e) {
          failedDestinations.push({
            destination: dest.name,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (failedDestinations.length === searchScope.destinations.length && searchScope.destinations.length > 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "search_failed",
            query: redactedQuery.text,
            search_scope: searchScope.name,
            searched_destinations: searchedDestinations,
            failed_destinations: failedDestinations,
          }, null, 2) }],
          isError: true,
        };
      }

      if (scopedResults.length === 0) {
        const nudge = buildMemoryNudge();
        if (output_format === "json") {
          return { content: [{ type: "text", text: JSON.stringify({
            query: redactedQuery.text,
            search_scope: searchScope.name,
            search_scope_description: searchScope.description,
            searched_destinations: searchedDestinations,
            failed_destinations: failedDestinations,
            requested_limit: requestedLimit,
            effective_limit: effectiveLimit,
            max_limit: MEMORY_RECALL_MAX_LIMIT,
            limit_clamped: effectiveLimit !== requestedLimit,
            graph_depth: graph_depth ?? 0,
            result_count: 0,
            related_count: 0,
            results: [],
            related: [],
            ...(nudge ? { nudge } : {}),
            ...(redactedQuery.redacted ? { query_redaction: redactedQuery } : {}),
          }, null, 2) }] };
        }
        const warning = failedDestinations.length > 0
          ? `\n\nSearch warnings: ${failedDestinations.map((failure) => `${failure.destination}: ${failure.error}`).join("; ")}`
          : "";
        const text = nudge
          ? `No matching facts found.${warning}\n\n${nudge}`
          : `No matching facts found.${warning}`;
        return { content: [{ type: "text", text }] };
      }

      const ranked = scopedResults
        .map((r) => ({ ...r, _combinedScore: computeCombinedScore(r) }))
        .sort((a, b) => b._combinedScore - a._combinedScore)
        .slice(0, effectiveLimit);

      await recordRecallTelemetry({
        ranked,
        redactedQuery,
        searchScope,
        searchedDestinations,
        failedDestinations,
      });

      const includeDestination = searchScope.destinations.length > 1 || searchScope.name === "all";
      const lines = ranked.map((r) => formatScopedFact(r, includeDestination));
      const related: { points: ScopedPoint[]; errors: Array<{ destination: string; error: string }> } = { points: [], errors: [] };

      if ((graph_depth ?? 0) >= 1) {
        const byDestination = new Map<string, { dest: Destination; points: QdrantPoint[] }>();
        for (const point of ranked) {
          const existing = byDestination.get(point._destination.name);
          if (existing) {
            existing.points.push(point);
          } else {
            byDestination.set(point._destination.name, { dest: point._destination, points: [point] });
          }
        }
        for (const entry of byDestination.values()) {
          const traversal = await graphTraversal(entry.dest, entry.points, effectiveLimit);
          related.points.push(...traversal.points.map((point) => withDestination(point, entry.dest)));
          if (traversal.error) {
            related.errors.push({ destination: entry.dest.name, error: traversal.error });
          }
        }
        related.points = related.points.slice(0, Math.ceil(effectiveLimit / 2));
        if (related.points.length > 0) {
          lines.push("", "── Related (1-hop) ──");
          lines.push(...related.points.map((r) => formatScopedFact(r, includeDestination)));
        }
        if (related.errors.length > 0) {
          lines.push("", `(graph traversal warnings: ${related.errors.map((failure) => `${failure.destination}: ${failure.error}`).join("; ")})`);
        }
      }

      if (failedDestinations.length > 0) {
        lines.push("", `(search warnings: ${failedDestinations.map((failure) => `${failure.destination}: ${failure.error}`).join("; ")})`);
      }
      const nudge = buildMemoryNudge();
      if (nudge) lines.push("", nudge);
      if (output_format === "json") {
        return { content: [{ type: "text", text: JSON.stringify({
          query: redactedQuery.text,
          search_scope: searchScope.name,
          search_scope_description: searchScope.description,
          searched_destinations: searchedDestinations,
          failed_destinations: failedDestinations,
          requested_limit: requestedLimit,
          effective_limit: effectiveLimit,
          max_limit: MEMORY_RECALL_MAX_LIMIT,
          limit_clamped: effectiveLimit !== requestedLimit,
          graph_depth: graph_depth ?? 0,
          result_count: ranked.length,
          related_count: related.points.length,
          results: ranked.map((r) => structuredScopedFact(r)),
          related: related.points.map((r) => structuredScopedFact(r)),
          ...(related.errors.length > 0 ? { graph_errors: related.errors } : {}),
          ...(nudge ? { nudge } : {}),
          ...(redactedQuery.redacted ? { query_redaction: redactedQuery } : {}),
        }, null, 2) }] };
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── memory_entity ───────────────────────────────────────────────────────

  mcp.tool(
    "memory_entity",
    [
      "Get everything bikky knows about a specific entity — facts mentioning it plus typed relations into and out of it.",
      "Prefer this over memory_recall when the user asks 'tell me about X' or 'what do we know about X' and X is a known entity name (service, person, repo, concept). Faster and more complete than semantic search for entity-centric queries.",
      "If you only have a fuzzy description, use memory_recall first to find the entity name.",
    ].join(" "),
    {
      name: z.string().describe(
        "Entity name (case-insensitive, e.g. 'qdrant', 'workspace_id'). Should match the lowercase canonical form used when facts were stored.",
      ),
      limit: z.number().optional().default(20).describe("Max facts to return (default 20). Relations are always returned in full, capped at 50 each direction."),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op."),
      destination: z.string().optional().describe("Optional legacy single-destination override. Do not combine with search_scope."),
      search_scope: searchScopeSchema.describe(
        "Optional read/search scope. Accepts 'routed', 'all', a destination name, a configured scope name, a comma-separated destination list, or an array of destination names. Omit to use config.default_search_scope.",
      ),
      include_legacy_workspace: z.boolean().optional().describe("[Removed in v0.4.0] No-op."),
    },
    async ({ name, limit, workspace_id: _workspace_id, destination, search_scope, include_legacy_workspace: _include_legacy_workspace }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const entityName = name.toLowerCase();
      const scopeResolved = resolveSearchScopeOrError({
        destination,
        search_scope,
        input: routingInput({ entities: [entityName] }),
      });
      if (scopeResolved.error) return scopeResolved.error;
      const searchScope = scopeResolved.scope;
      const effectiveLimit = Math.max(1, Math.trunc(limit ?? 20));
      const entityTypes = new Map<string, string>();
      const factPoints: ScopedPoint[] = [];
      const relationPoints: ScopedPoint[] = [];
      const failures: Array<{ destination: string; error: string }> = [];

      for (const dest of searchScope.destinations) {
        // Look up the daemon-classified entity type, if any.
        try {
          const typeFilter: QdrantFilter = buildFilter({}) ?? { must: [] };
          typeFilter.must.push({ key: "kind", match: { value: "entity_type" } });
          typeFilter.must.push({ key: "entity_name", match: { value: entityName } });
          const typePoints = await qdrantScroll(dest, typeFilter, 1);
          const typePoint = typePoints.result?.points?.[0];
          const payload = typePoint?.payload as unknown as Record<string, unknown> | undefined;
          if (payload?.entity_type) {
            entityTypes.set(dest.name, String(payload.entity_type));
          }
        } catch {
          // Type lookup is best-effort — never fails the request.
        }

        try {
          const factsFilter: QdrantFilter = buildFilter({}) ?? { must: [] };
          factsFilter.must.push({ key: "entities", match: { value: entityName } });
          const facts = await qdrantScroll(dest, factsFilter, effectiveLimit);
          factPoints.push(...(facts.result?.points ?? []).map((point) => withDestination(point, dest)));

          const fromFilter: QdrantFilter = buildFilter({}) ?? { must: [] };
          fromFilter.must.push({ key: "from_entity", match: { value: entityName } });
          const relationsFrom = await qdrantScroll(dest, fromFilter, 50);

          const toFilter: QdrantFilter = buildFilter({}) ?? { must: [] };
          toFilter.must.push({ key: "to_entity", match: { value: entityName } });
          const relationsTo = await qdrantScroll(dest, toFilter, 50);
          relationPoints.push(...[
            ...(relationsFrom.result?.points ?? []),
            ...(relationsTo.result?.points ?? []),
          ].map((point) => withDestination(point, dest)));
        } catch (e) {
          failures.push({ destination: dest.name, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (failures.length === searchScope.destinations.length && searchScope.destinations.length > 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "search_failed",
            entity: entityName,
            search_scope: searchScope.name,
            searched_destinations: searchScope.destinations.map((dest) => dest.name),
            failed_destinations: failures,
          }, null, 2) }],
          isError: true,
        };
      }

      const output: string[] = [];
      const includeDestination = searchScope.destinations.length > 1 || searchScope.name === "all";
      const entityTypeValues = [...new Set(entityTypes.values())];
      const entityType = entityTypeValues.length === 1 ? entityTypeValues[0] : null;

      if (factPoints.length > 0) {
        const header = entityType
          ? `## Facts about ${name} [type: ${entityType}] (${Math.min(factPoints.length, effectiveLimit)})`
          : `## Facts about ${name} (${Math.min(factPoints.length, effectiveLimit)})`;
        output.push(header);
        for (const p of factPoints.slice(0, effectiveLimit)) {
          if (p.payload.category !== "relation") {
            output.push(`- ${formatScopedFact(p, includeDestination)}`);
          }
        }
      } else if (entityType) {
        output.push(`## ${name} [type: ${entityType}]`);
      }

      const seen = new Set<string>();
      const uniqueRelations = relationPoints.filter((r) => {
        const key = `${r._destination.name}:${r.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (uniqueRelations.length > 0) {
        output.push(`\n## Relations (${uniqueRelations.length})`);
        for (const r of uniqueRelations) {
          const p = r.payload;
          const prefix = includeDestination ? `[${r._destination.name}] ` : "";
          output.push(`- ${prefix}${p.from_entity} --[${p.relation_type}]--> ${p.to_entity}`);
        }
      }

      if (failures.length > 0) {
        output.push(`\nSearch warnings: ${failures.map((failure) => `${failure.destination}: ${failure.error}`).join("; ")}`);
      }

      if (output.length === 0) {
        return { content: [{ type: "text", text: `No facts or relations found for '${name}'.` }] };
      }

      return { content: [{ type: "text", text: output.join("\n") }] };
    },
  );

  // ── memory_relations ────────────────────────────────────────────────────

  mcp.tool(
    "memory_relations",
    [
      "Query typed edges between entities. Returns 'A --[type]--> B' triples that semantic search alone wouldn't surface.",
      "Use for 'what does X own / use / depend on?' and 'who owns Y?' style questions. Optionally filter by direction (from / to / both) and relation type.",
      "To create relations, use memory_store with the 'relation' field — there is no separate create-relation tool.",
    ].join(" "),
    {
      entity: z.string().describe("Entity name to query (case-insensitive)."),
      relation_type: z.string().optional().describe(
        "Filter to a specific edge label (e.g. 'owns', 'uses', 'decided', 'prefers', 'works-on'). Optional.",
      ),
      direction: z.enum(["from", "to", "both"]).optional().default("both").describe(
        "Which side of the edge the entity is on. 'from' = entity is the source (X --[?]--> ?). 'to' = entity is the target (? --[?]--> X). 'both' = either (default).",
      ),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op."),
      destination: z.string().optional().describe("Optional legacy single-destination override. Do not combine with search_scope."),
      search_scope: searchScopeSchema.describe(
        "Optional read/search scope. Accepts 'routed', 'all', a destination name, a configured scope name, a comma-separated destination list, or an array of destination names. Omit to use config.default_search_scope.",
      ),
      include_legacy_workspace: z.boolean().optional().describe("[Removed in v0.4.0] No-op."),
    },
    async ({ entity, relation_type, direction, workspace_id: _workspace_id, destination, search_scope, include_legacy_workspace: _include_legacy_workspace }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const entityName = entity.toLowerCase();
      const scopeResolved = resolveSearchScopeOrError({
        destination,
        search_scope,
        input: routingInput({ entities: [entityName] }),
      });
      if (scopeResolved.error) return scopeResolved.error;
      const searchScope = scopeResolved.scope;
      const results: ScopedPoint[] = [];
      const failures: Array<{ destination: string; error: string }> = [];

      for (const dest of searchScope.destinations) {
        try {
          if (direction === "from" || direction === "both") {
            const filter: QdrantFilter = buildFilter({}) ?? { must: [] };
            filter.must.push({ key: "from_entity", match: { value: entityName } });
            if (relation_type) {
              filter.must.push({ key: "relation_type", match: { value: relation_type.toLowerCase() } });
            }
            const r = await qdrantScroll(dest, filter, 50);
            results.push(...(r.result?.points ?? []).map((point) => withDestination(point, dest)));
          }

          if (direction === "to" || direction === "both") {
            const filter: QdrantFilter = buildFilter({}) ?? { must: [] };
            filter.must.push({ key: "to_entity", match: { value: entityName } });
            if (relation_type) {
              filter.must.push({ key: "relation_type", match: { value: relation_type.toLowerCase() } });
            }
            const r = await qdrantScroll(dest, filter, 50);
            results.push(...(r.result?.points ?? []).map((point) => withDestination(point, dest)));
          }
        } catch (e) {
          failures.push({ destination: dest.name, error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (failures.length === searchScope.destinations.length && searchScope.destinations.length > 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "search_failed",
            entity: entityName,
            search_scope: searchScope.name,
            searched_destinations: searchScope.destinations.map((dest) => dest.name),
            failed_destinations: failures,
          }, null, 2) }],
          isError: true,
        };
      }

      const seen = new Set<string>();
      const unique = results.filter((r) => {
        const key = `${r._destination.name}:${r.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (unique.length === 0) {
        const warning = failures.length > 0
          ? ` Search warnings: ${failures.map((failure) => `${failure.destination}: ${failure.error}`).join("; ")}`
          : "";
        return { content: [{ type: "text", text: `No relations found for '${entity}'.${warning}` }] };
      }

      const includeDestination = searchScope.destinations.length > 1 || searchScope.name === "all";
      const lines = unique.map((r) => {
        const p = r.payload;
        const prefix = includeDestination ? `[${r._destination.name}] ` : "";
        return `${prefix}${p.from_entity} --[${p.relation_type}]--> ${p.to_entity} (confidence: ${p.confidence}, id: ${r.id})`;
      });
      if (failures.length > 0) {
        lines.push("", `Search warnings: ${failures.map((failure) => `${failure.destination}: ${failure.error}`).join("; ")}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── memory_forget ───────────────────────────────────────────────────────

  mcp.tool(
    "memory_forget",
    [
      "Mark a fact as superseded/wrong. The fact stays in storage (for audit) but is excluded from all recall results.",
      "Use this when a fact was simply incorrect or no longer applies and there is no replacement. If you have a corrected version, use memory_store with 'supersedes: <fact_id>' instead — that way the new fact stays linked to the old one.",
    ].join(" "),
    {
      fact_id: z.string().describe("ID of the fact to forget (returned by memory_store / memory_recall as 'id')."),
      reason: z.string().describe(
        "Short human-readable reason this fact is being retired (stored in 'superseded_by' for future audit).",
      ),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op."),
    },
    async ({ fact_id, reason, workspace_id: _workspace_id }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const now = nowISO();
      try {
        const located = await locatePoint(fact_id);
        if (!located) return notFoundResult(fact_id);
        const { dest } = located;
        const redactedReason = redactStorageText(reason);
        await qdrantSetPayload(dest, [fact_id], {
          superseded_by: `forgotten:${redactedReason.text}`,
          superseded_at: now,
          updated_at: now,
          last_operation_origin: mcpOrigin({
            action: "forget",
            tool: "memory_forget",
            metadata: { destination: dest.name, fact_id },
          }),
          // Mark this fact's vector as a bad-exemplar centroid: future
          // candidates with high cosine similarity will be auto-flagged
          // for review. Forgotten facts keep their original vector — the
          // is_bad_exemplar payload flag opts them into the centroid set
          // without requiring a new point.
          is_bad_exemplar: true,
          bad_exemplar_reason: redactedReason.text,
        });
        return { content: [{ type: "text", text: JSON.stringify({
          status: "forgotten",
          fact_id,
          destination: dest.name,
          reason: redactedReason.text,
          ...(redactedReason.redacted ? { redaction: redactedReason } : {}),
        }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  // ── memory_verify ───────────────────────────────────────────────────────

  mcp.tool(
    "memory_verify",
    [
      "Confirm an existing fact is still accurate, without re-storing it. Resets the staleness clock and bumps a verification counter.",
      "Use this when memory_heartbeat surfaces a stale fact ID and you can confirm it's still true (e.g. you just observed the system in that state). Lighter than memory_store(supersedes:) — same content, fresh timestamp.",
      "If the fact is no longer true, use memory_forget or memory_store(supersedes:) instead.",
    ].join(" "),
    {
      fact_id: z.string().describe("ID of the fact to verify (from memory_recall or memory_heartbeat)."),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op."),
    },
    async ({ fact_id, workspace_id: _workspace_id }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const now = nowISO();
      try {
        const located = await locatePoint(fact_id);
        if (!located) return notFoundResult(fact_id);
        const { dest, point } = located;
        const currentCount = point.payload.verification_count ?? 0;
        const newCount = currentCount + 1;
        await qdrantSetPayload(dest, [fact_id], {
          last_verified_at: now,
          last_reinforced_at: now,
          verification_count: newCount,
          updated_at: now,
          last_operation_origin: mcpOrigin({
            action: "verify",
            tool: "memory_verify",
            metadata: { destination: dest.name, fact_id },
          }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "verified",
            fact_id,
            destination: dest.name,
            verification_count: newCount,
            message: "Fact confirmed as still accurate. Staleness clock reset.",
          }) }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  // ── memory_mark_useful ──────────────────────────────────────────────────

  mcp.tool(
    "memory_mark_useful",
    [
      "Report that a previously recalled fact actually helped you answer the user's question or complete a task.",
      "Bumps a 'useful_count' counter on the fact and writes a telemetry feedback_event row that future ranking work can aggregate.",
      "Call this AFTER you used a fact from memory_recall / memory_entity and confirmed it was helpful — not for every recalled fact. If the fact was wrong or misleading, use memory_report_outcome with outcome='wrong' or 'misleading' instead.",
    ].join(" "),
    {
      fact_id: z.string().describe("ID of the fact that was useful (from memory_recall or memory_entity)."),
      note: z.string().optional().describe(
        "Optional short note about how the fact was useful (e.g. 'unblocked auth debug'). Stored on the telemetry event for future analysis.",
      ),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op."),
    },
    async ({ fact_id, note, workspace_id: _workspace_id }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const now = nowISO();
      try {
        const located = await locatePoint(fact_id);
        if (!located) return notFoundResult(fact_id);
        const { dest, point } = located;
        const currentCount = point.payload.useful_count ?? 0;
        const newCount = currentCount + 1;
        const feedbackOrigin = mcpOrigin({
          action: "feedback",
          tool: "memory_mark_useful",
          outcome: "useful",
          metadata: { destination: dest.name, fact_id },
        });
        await qdrantSetPayload(dest, [fact_id], {
          useful_count: newCount,
          last_useful_at: now,
          updated_at: now,
          last_operation_origin: feedbackOrigin,
        });

        // Write a telemetry feedback_event row so the signal is also visible
        // to aggregations and review tooling.
        const eventId = newId();
        const eventContent = note
          ? `Fact ${fact_id} marked useful: ${note}`
          : `Fact ${fact_id} marked useful.`;
        const redactedEvent = redactStorageText(eventContent);
        const eventPayload: Record<string, unknown> = {
          content: redactedEvent.text,
          category: categoryForMemorySubtype("feedback_event") ?? "system",
          domain: "software_engineering",
          kind: "telemetry",
          memory_subtype: "feedback_event",
          layer: "memory_object",
          entities: [],
          origin: feedbackOrigin,
          confidence: 1.0,
          importance: 0.3,
          content_hash: contentHash("feedback_event", `${fact_id}:useful:${now}`),
          target_fact_id: fact_id,
          feedback_kind: "useful",
          created_at: now,
          updated_at: now,
        };
        addRedactionPayload(eventPayload, redactedEvent);
        try {
          const eventVector = await embed(redactedEvent.text);
          await qdrantUpsert(dest, eventId, eventVector, eventPayload);
        } catch (e) {
          log("WARN", `Failed to record feedback_event: ${e instanceof Error ? e.message : String(e)}`);
        }

        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "marked_useful",
            fact_id,
            destination: dest.name,
            useful_count: newCount,
            event_id: eventId,
          }) }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  // ── memory_report_outcome ───────────────────────────────────────────────

  mcp.tool(
    "memory_report_outcome",
    [
      "Report the downstream outcome of using a recalled fact — useful, misleading, irrelevant, or wrong.",
      "Writes a telemetry outcome_event row that future ranking and review work can aggregate. Unlike memory_mark_useful (positive-only, bumps a counter), this records a richer signal including negative outcomes and optional notes.",
      "Use this when you can confidently judge whether a fact actually helped: 'useful' = helped you complete the task; 'misleading' = pointed in a wrong direction; 'irrelevant' = matched semantically but didn't help; 'wrong' = factually incorrect (also consider memory_forget for clearly wrong facts).",
    ].join(" "),
    {
      fact_id: z.string().describe("ID of the fact whose outcome you are reporting."),
      outcome: z.enum(["useful", "misleading", "irrelevant", "wrong"]).describe(
        "How the fact actually played out. 'useful' = helped you finish the task; 'misleading' = sent you the wrong way; 'irrelevant' = semantically matched but didn't help; 'wrong' = factually incorrect.",
      ),
      notes: z.string().optional().describe(
        "Optional short context for the outcome (e.g. 'API moved in v2', 'wrong port number'). Stored on the telemetry event for future analysis.",
      ),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op."),
    },
    async ({ fact_id, outcome, notes, workspace_id: _workspace_id }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const now = nowISO();
      try {
        const located = await locatePoint(fact_id);
        if (!located) return notFoundResult(fact_id);
        const { dest } = located;
        const feedbackOrigin = mcpOrigin({
          action: "feedback",
          tool: "memory_report_outcome",
          outcome,
          metadata: { destination: dest.name, fact_id },
        });
        await qdrantSetPayload(dest, [fact_id], {
          updated_at: now,
          last_operation_origin: feedbackOrigin,
        });

        const eventId = newId();
        const eventContent = notes
          ? `Fact ${fact_id} outcome=${outcome}: ${notes}`
          : `Fact ${fact_id} outcome=${outcome}.`;
        const redactedEvent = redactStorageText(eventContent);
        const eventPayload: Record<string, unknown> = {
          content: redactedEvent.text,
          category: categoryForMemorySubtype("outcome_event") ?? "system",
          domain: "software_engineering",
          kind: "telemetry",
          memory_subtype: "outcome_event",
          layer: "memory_object",
          entities: [],
          origin: feedbackOrigin,
          confidence: 1.0,
          importance: outcome === "wrong" || outcome === "misleading" ? 0.6 : 0.3,
          content_hash: contentHash("outcome_event", `${fact_id}:${outcome}:${now}`),
          target_fact_id: fact_id,
          outcome,
          created_at: now,
          updated_at: now,
        };
        addRedactionPayload(eventPayload, redactedEvent);
        const eventVector = await embed(redactedEvent.text);
        await qdrantUpsert(dest, eventId, eventVector, eventPayload);

        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "outcome_recorded",
            fact_id,
            destination: dest.name,
            outcome,
            event_id: eventId,
          }) }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  // ── memory_session_summary ──────────────────────────────────────────────

  mcp.tool(
    "memory_session_summary",
    [
      "Persist a compact summary of the current session — what got done, what decisions were made, what's still open.",
      "Stored as kind='summary', memory_subtype='session_index' with canonical origin metadata. Keep it short (target 30-80 words). Future sessions retrieve these via memory_recall to bootstrap context faster than re-reading the original transcript.",
      "Call this near session close (or at major milestone boundaries) when the work is meaningful enough to want a future agent to inherit. Skip for trivial single-question sessions.",
    ].join(" "),
    {
      content: z.string().describe(
        "The summary text. Atomic, self-contained, 30-80 words ideally. Should answer: what was the goal, what did we do, what remains?",
      ),
      entities: z.array(z.string()).optional().describe(
        "Lowercase entity names mentioned by the summary (services, repos, people, concepts). Used for entity-scoped recall later.",
      ),
      episode_id: z.string().optional().describe("Coherent activity-segment ID for grouping with related captures."),
      workstream_key: z.string().optional().describe("Durable continuity key for a long-running objective (survives across sessions)."),
      task_key: z.string().optional().describe("Task or issue key (e.g. GitHub issue number, JIRA key)."),
      repo: z.string().optional().describe("Repository or project surface this summary relates to."),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op."),
      destination: z.string().optional().describe("Optional destination override. Omit to let routing rules decide."),
    },
    async ({ content, entities, episode_id, workstream_key, task_key, repo, workspace_id: _workspace_id, destination }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      lastStoreTime = Date.now();
      const now = nowISO();
      try {
        const resolved = resolveDestOrError(routingInput({
          destination,
          content,
          entities: entities ?? [],
        }));
        if (resolved.error) return resolved.error;
        const dest = resolved.dest;
        const normalizedEntities = (entities ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
        const summaryId = newId();
        const redactedContent = redactStorageText(content);
        const vector = await embed(redactedContent.text);
        const origin = mcpOrigin({
          action: "create",
          tool: "memory_session_summary",
          metadata: {
            destination: dest.name,
            ...(episode_id ? { episode_id } : {}),
            ...(workstream_key ? { workstream_key } : {}),
            ...(task_key ? { task_key } : {}),
            ...(repo ? { repo } : {}),
          },
        });
        const payload: Record<string, unknown> = {
          content: redactedContent.text,
          category: categoryForMemorySubtype("session_index") ?? "system",
          domain: "software_engineering",
          kind: "summary",
          memory_subtype: "session_index",
          layer: layerForMemorySubtype("session_index") ?? "episode",
          entities: normalizedEntities,
          origin,
          confidence: 0.9,
          importance: 0.6,
          content_hash: contentHash("summary", redactedContent.text),
          reinforcement_count: 1,
          last_reinforced_at: now,
          superseded_by: null,
          superseded_at: null,
          created_at: now,
          updated_at: now,
        };
        if (episode_id) payload["episode_id"] = episode_id;
        if (workstream_key) payload["workstream_key"] = workstream_key;
        if (task_key) payload["task_key"] = task_key;
        if (repo) payload["repo"] = repo;
        addRedactionPayload(payload, redactedContent);
        await qdrantUpsert(dest, summaryId, vector, payload);

        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "summary_stored",
            summary_id: summaryId,
            destination: dest.name,
            origin,
          }) }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  // ── memory_distill ──────────────────────────────────────────────────────

  mcp.tool(
    "memory_distill",
    [
      "Persist a distilled convention — a reusable learning, pattern, or runbook synthesized from multiple prior memories.",
      "Stored as kind='distilled', memory_subtype='convention' with canonical origin metadata. Use this when you've noticed a pattern across several prior facts/sessions that's worth surfacing as its own atomic learning. The new memory will rank above raw facts in semantic recall because distilled patterns are higher-signal.",
      "Provide 'supersedes' if this distillation replaces an earlier convention. The original stays in storage but is excluded from recall.",
    ].join(" "),
    {
      content: z.string().describe(
        "One-sentence reusable convention or pattern. Should be self-contained and applicable beyond a single situation.",
      ),
      entities: z.array(z.string()).describe(
        "Lowercase entity names this distillation applies to (services, tools, concepts).",
      ),
      supersedes: z.string().optional().describe(
        "ID of an earlier distilled fact that this one replaces. Old fact is marked superseded and excluded from recall.",
      ),
      task_key: z.string().optional().describe("Task or issue key associated with this learning, if relevant."),
      repo: z.string().optional().describe("Repository or project surface this learning applies to."),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op."),
      destination: z.string().optional().describe("Optional destination override. Omit to let routing rules decide."),
    },
    async ({ content, entities, supersedes, task_key, repo, workspace_id: _workspace_id, destination }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      lastStoreTime = Date.now();
      const now = nowISO();
      try {
        const resolved = resolveDestOrError(routingInput({
          destination,
          content,
          entities,
        }));
        if (resolved.error) return resolved.error;
        const dest = resolved.dest;
        const normalizedEntities = entities.map((e) => e.trim().toLowerCase()).filter(Boolean);
        const distilledId = newId();
        const redactedContent = redactStorageText(content);
        const vector = await embed(redactedContent.text);
        const origin = mcpOrigin({
          action: "create",
          tool: "memory_distill",
          metadata: {
            destination: dest.name,
            ...(task_key ? { task_key } : {}),
            ...(repo ? { repo } : {}),
            ...(supersedes ? { supersedes } : {}),
          },
        });

        if (supersedes) {
          // Supersede may live in a different destination — locate it.
          const located = await locatePoint(supersedes);
          if (!located) return notFoundResult(supersedes);
          await qdrantSetPayload(located.dest, [supersedes], {
            superseded_by: distilledId,
            superseded_at: now,
            updated_at: now,
            last_operation_origin: mcpOrigin({
              action: "supersede",
              tool: "memory_distill",
              metadata: { destination: located.dest.name, new_fact_id: distilledId },
            }),
          });
        }

        const payload: Record<string, unknown> = {
          content: redactedContent.text,
          category: categoryForMemorySubtype("convention") ?? "engineering",
          domain: "software_engineering",
          kind: "distilled",
          memory_subtype: "convention",
          layer: layerForMemorySubtype("convention") ?? "domain",
          entities: normalizedEntities,
          origin,
          confidence: 0.9,
          importance: 0.7,
          content_hash: contentHash("distilled", redactedContent.text),
          reinforcement_count: 1,
          last_reinforced_at: now,
          superseded_by: null,
          superseded_at: null,
          created_at: now,
          updated_at: now,
        };
        if (task_key) payload["task_key"] = task_key;
        if (repo) payload["repo"] = repo;
        addRedactionPayload(payload, redactedContent);
        await qdrantUpsert(dest, distilledId, vector, payload);

        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "distilled_stored",
            distilled_id: distilledId,
            destination: dest.name,
            supersedes: supersedes ?? null,
            origin,
          }) }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    },
  );

  // ── memory_review ───────────────────────────────────────────────────────

  mcp.tool(
    "memory_review",
    [
      "Triage facts that were captured automatically by Bikky (origin.interface='daemon' or legacy source='system').",
      "Only useful when the daemon is running and capturing memories from logs/transcripts; otherwise this returns an empty list. Supports four actions: list (default — show recent daemon/system-captured facts), approve (mark verified), reject (mark superseded with reason), correct (replace with edited content as a new fact).",
    ].join(" "),
    {
      limit: z.number().optional().default(10).describe("Max facts to return when action=list (default 10)."),
      action: z.enum(["list", "approve", "reject", "correct"]).optional().default("list").describe(
        "What to do. list = show recent system-captured facts (default). approve = confirm a fact is correct (bumps verification count). reject = mark a fact as wrong (requires 'reason'). correct = supersede with an edited version (requires 'corrected_content').",
      ),
      fact_id: z.string().optional().describe("Fact ID to act on. Required for approve / reject / correct."),
      reason: z.string().optional().describe("Required for action=reject. Short reason the fact is wrong."),
      corrected_content: z.string().optional().describe(
        "Required for action=correct. The fixed fact text. Stored as a new fact that supersedes the original.",
      ),
      workspace_id: z.string().optional().describe("[Removed in v0.4.0] No-op."),
      include_legacy_workspace: z.boolean().optional().describe("[Removed in v0.4.0] No-op."),
    },
    async ({ limit, action, fact_id, reason, corrected_content, workspace_id: _workspace_id, include_legacy_workspace: _include_legacy_workspace }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;

      if (action === "list") {
        // List spans all destinations.
        const destinations = listDestinations();
        const allPoints: Array<{ dest: string; point: { id: string; payload: FactPayload } }> = [];
        const filter: QdrantFilter = {
          must: [],
          should: [
            { key: "origin.interface", match: { value: "daemon" } },
            { key: "origin.agent.type", match: { any: ["daemon", "system"] } },
            { key: "source", match: { any: ["system", "daemon"] } },
          ],
        };
        for (const dest of destinations) {
          try {
            const result = await qdrantScroll(dest, filter, (limit ?? 10) * 2);
            const points = result.result?.points ?? [];
            for (const pt of points) allPoints.push({ dest: dest.name, point: pt });
          } catch (e) {
            log("WARN", `memory_review list scroll failed on ${dest.name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        const sorted = allPoints
          .sort((a, b) => (b.point.payload.created_at ?? "").localeCompare(a.point.payload.created_at ?? ""))
          .slice(0, limit ?? 10);

        if (sorted.length === 0) {
          return { content: [{ type: "text", text: "No system-captured facts found." }] };
        }

        const lines = sorted.map(({ dest, point: pt }) => {
          const p = pt.payload;
          return `[${p.category}] ${p.content}\n  id: ${pt.id} | dest: ${dest} | confidence: ${p.confidence} | importance: ${p.importance} | entities: ${(p.entities ?? []).join(", ")} | created: ${p.created_at}`;
        });
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }

      if (!fact_id) {
        return { content: [{ type: "text", text: "Error: fact_id is required for approve/reject/correct actions." }] };
      }

      const now = nowISO();

      if (action === "approve") {
        const located = await locatePoint(fact_id);
        if (!located) return notFoundResult(fact_id);
        const { dest, point } = located;
        const currentCount = point.payload.verification_count ?? 0;
        await qdrantSetPayload(dest, [fact_id], {
          last_verified_at: now,
          verification_count: currentCount + 1,
          updated_at: now,
          last_operation_origin: mcpOrigin({
            action: "review",
            tool: "memory_review",
            outcome: "approved",
            metadata: { destination: dest.name, fact_id },
          }),
        });
        return { content: [{ type: "text", text: JSON.stringify({ status: "approved", fact_id, destination: dest.name }) }] };
      }

      if (action === "reject") {
        if (!reason) {
          return { content: [{ type: "text", text: "Error: reason is required for reject action." }] };
        }
        const located = await locatePoint(fact_id);
        if (!located) return notFoundResult(fact_id);
        const { dest } = located;
        const redactedReason = redactStorageText(reason);
        await qdrantSetPayload(dest, [fact_id], {
          superseded_by: `rejected:${redactedReason.text}`,
          superseded_at: now,
          updated_at: now,
          last_operation_origin: mcpOrigin({
            action: "review",
            tool: "memory_review",
            outcome: "rejected",
            metadata: { destination: dest.name, fact_id },
          }),
        });
        return { content: [{ type: "text", text: JSON.stringify({
          status: "rejected",
          fact_id,
          destination: dest.name,
          reason: redactedReason.text,
          ...(redactedReason.redacted ? { redaction: redactedReason } : {}),
        }) }] };
      }

      if (action === "correct") {
        if (!corrected_content) {
          return { content: [{ type: "text", text: "Error: corrected_content is required for correct action." }] };
        }
        const located = await locatePoint(fact_id);
        if (!located) return notFoundResult(fact_id);
        const { dest, point } = located;
        const origPayload = point.payload;
        const redactedCorrected = redactStorageText(corrected_content);

        const vector = await embed(redactedCorrected.text);
        const correctedId = crypto.randomUUID();
        const origCategory = normalizeCategory(origPayload?.category ?? DEFAULT_CATEGORY);
        const hash = contentHash(origCategory, redactedCorrected.text);
        const correctOrigin = mcpOrigin({
          action: "correct",
          tool: "memory_review",
          metadata: { destination: dest.name, corrected_from: fact_id },
        });
        const correctedPayload: Record<string, unknown> = {
          content: redactedCorrected.text,
          category: origCategory,
          domain: normalizeDomain(origPayload?.domain ?? DEFAULT_DOMAIN),
          kind: normalizeKind(origPayload?.kind ?? "fact"),
          ...(origPayload?.memory_subtype ? { memory_subtype: origPayload.memory_subtype } : {}),
          ...(origPayload?.layer ? { layer: origPayload.layer } : {}),
          ...(origPayload?.episode_id ? { episode_id: origPayload.episode_id } : {}),
          ...(origPayload?.workstream_key ? { workstream_key: origPayload.workstream_key } : {}),
          ...(origPayload?.task_key ? { task_key: origPayload.task_key } : {}),
          ...(origPayload?.repo ? { repo: origPayload.repo } : {}),
          ...(origPayload?.branch ? { branch: origPayload.branch } : {}),
          entities: origPayload?.entities ?? [],
          origin: correctOrigin,
          confidence: 0.95,
          importance: origPayload?.importance ?? 0.5,
          content_hash: hash,
          reinforcement_count: 1,
          last_reinforced_at: now,
          superseded_by: null,
          superseded_at: null,
          created_at: now,
          updated_at: now,
          metadata: { ...(origPayload?.metadata ?? {}), corrected_from: fact_id },
        };
        addRedactionPayload(correctedPayload, redactedCorrected);
        await qdrantUpsert(dest, correctedId, vector, correctedPayload);

        await qdrantSetPayload(dest, [fact_id], {
          superseded_by: correctedId,
          superseded_at: now,
          updated_at: now,
          last_operation_origin: mcpOrigin({
            action: "supersede",
            tool: "memory_review",
            outcome: "corrected",
            metadata: { destination: dest.name, new_fact_id: correctedId },
          }),
        });

        return { content: [{ type: "text", text: JSON.stringify({ status: "corrected", old_fact_id: fact_id, new_fact_id: correctedId, destination: dest.name }) }] };
      }

      return { content: [{ type: "text", text: `Unknown action: ${String(action)}` }] };
    },
  );

  // ── memory_heartbeat ────────────────────────────────────────────────────

  mcp.tool(
    "memory_heartbeat",
    [
      "Reflection check-in. Returns up to three things: a memory nudge if you haven't stored anything in 10+ minutes, stale-fact alerts every 3rd call (with IDs you can pass to memory_verify or memory_forget), and a reflection prompt asking whether the last few minutes of work produced anything worth storing.",
      "Call periodically during interactive sessions — roughly every 10 minutes or every 3rd user prompt. No arguments. Cheap and read-only.",
    ].join(" "),
    {},
    async (): Promise<McpToolResult> => {
      heartbeatCount++;
      const sections: string[] = [];

      const nudge = buildMemoryNudge();
      if (nudge) sections.push(nudge);

      if (heartbeatCount % 3 === 0 && ready) {
        try {
          const staleThreshold = new Date(Date.now() - STALENESS_DAYS * 86400000).toISOString();
          const staleFilter: QdrantFilter = { must: [] };
          staleFilter.must.push({ key: "category", match: { any: ["engineering", "product", "human", "system"] } });
          staleFilter.should = [
            { key: "last_reinforced_at", range: { lte: staleThreshold } },
            { is_null: { key: "last_reinforced_at" } },
          ];
          staleFilter.must_not = [
            { key: "last_verified_at", range: { gte: staleThreshold } },
          ];
          // Aggregate stale facts across all destinations.
          const staleFacts: Array<{ id: string; payload: FactPayload }> = [];
          for (const dest of listDestinations()) {
            try {
              const r = await qdrantScroll(dest, staleFilter, 3);
              const pts = r.result?.points ?? [];
              for (const pt of pts) staleFacts.push(pt);
              if (staleFacts.length >= 3) break;
            } catch (e) {
              log("WARN", `Staleness check failed on ${dest.name}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          const trimmed = staleFacts.slice(0, 3);
          if (trimmed.length > 0) {
            const staleLines = trimmed.map((f) => {
              const d = Math.round(daysSince(lastActivityDate(f.payload)));
              return `  • [${f.payload.category}] ${f.payload.content} (${d}d old, id: ${f.id})`;
            });
            sections.push(
              `🕰️ **Stale facts** — these haven't been verified in ${STALENESS_DAYS}+ days. Still accurate?\n` +
              staleLines.join("\n") +
              "\n  → Use `memory_verify(fact_id)` to confirm, `memory_forget(fact_id, reason)` to retire, or `memory_store(supersedes: fact_id)` to replace.",
            );
          }
        } catch (e) {
          log("WARN", `Staleness check failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      sections.push(
        "🔍 Reflect: think about the LAST 10 minutes of work and answer in your head:\n" +
        "  1. Did you touch engineering context: code, infra, ops, access, troubleshooting, or conventions?\n" +
        "  2. Did you capture product context: a requirement, decision, workflow, roadmap item, metric, or market insight?\n" +
        "  3. Did you learn human context: a preference, owner, working agreement, person profile, or durable activity event?\n" +
        "  4. Did the work produce system context: session, episode, workstream, recall, feedback, outcome, or rollup state?\n" +
        "If any answer is yes, call memory_store now — one atomic fact per item, with category/domain/entities.",
      );

      return { content: [{ type: "text", text: sections.join("\n\n") }] };
    },
  );
}
