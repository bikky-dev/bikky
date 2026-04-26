/**
 * MCP tool definitions for memory.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import crypto from "node:crypto";
import { z } from "zod";
import type { McpToolResult, QdrantFilter, QdrantPoint } from "./types.js";
import {
  STALENESS_DAYS,
  THRESHOLD_DUPLICATE,
  THRESHOLD_RELATED,
  QDRANT_INDEXES,
  categoryValues,
  domainValues,
  kindValues,
  memorySubtypeValues,
  sourceValues,
  DEFAULT_CATEGORY,
  DEFAULT_DOMAIN,
  DEFAULT_KIND,
  DEFAULT_SOURCE,
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
  MEMORY_RECALL_EXCLUDED_KINDS,
} from "./helpers.js";
import {
  ready,
  qdrantUrl,
  qdrantApiKey,
  setQdrantUrl,
  setQdrantApiKey,
  setReady,
  getCollection,
  log,
  embed,
  getEmbeddingConfig,
  qdrantReq,
  ensureCollection,
  qdrantUpsert,
  qdrantSearch,
  qdrantScroll,
  qdrantSetPayload,
  qdrantGetPoints,
} from "./api.js";
import { saveConfig, loadConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const NUDGE_INTERVAL_MS = 10 * 60 * 1000;
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

interface WorkspaceScope {
  workspaceId?: string;
  actorId?: string;
  includeLegacy: boolean;
}

interface RedactionResult {
  text: string;
  redacted: boolean;
  summary: string;
  matches: Array<{ type: string; count: number }>;
}

type RedactionSummary = Omit<RedactionResult, "text">;

function redactionOptions(): { enabled: boolean; redactPii: boolean } {
  return { enabled: false, redactPii: false };
}

function redactStorageText(text: string): RedactionResult {
  return { text, redacted: false, summary: "none", matches: [] };
}

function combineRedactions(_items: RedactionResult[]): RedactionSummary {
  return { redacted: false, summary: "none", matches: [] };
}

function resolveScope(workspaceId?: string, includeLegacyWorkspace = false): WorkspaceScope {
  return {
    workspaceId: workspaceId?.trim() || undefined,
    includeLegacy: includeLegacyWorkspace,
  };
}

function scopedFilter(scope: WorkspaceScope, extra: Parameters<typeof buildFilter>[0] = {}): QdrantFilter | undefined {
  return buildFilter({
    ...extra,
    workspace_id: scope.workspaceId,
    includeLegacyWorkspace: scope.includeLegacy,
  });
}

function addWorkspacePayload(payload: Record<string, unknown>, scope: WorkspaceScope): void {
  if (scope.workspaceId) payload["workspace_id"] = scope.workspaceId;
  if (scope.actorId) payload["actor_id"] = scope.actorId;
}

function addRedactionPayload(_payload: Record<string, unknown>, _summary: RedactionSummary): void {
  // Task 243 keeps storage pass-through; redaction policy is out of scope for this branch.
}

async function getPointForWorkspaceWrite(factId: string, _scope: WorkspaceScope): Promise<{ point?: QdrantPoint; error?: Record<string, unknown> }> {
  const existing = await qdrantGetPoints([factId]);
  const point = existing.result?.[0];
  if (!point) {
    return { error: { status: "not_found", fact_id: factId } };
  }
  return { point };
}

function requireReady(): McpToolResult | null {
  if (!ready) {
    const missing: string[] = [];
    if (!qdrantUrl) missing.push("qdrant-url");
    if (!qdrantApiKey) missing.push("qdrant-api-key");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "setup_required",
          ready: false,
          missing,
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
    "  • infrastructure — new services, ports, configs touched?\n" +
    "  • decisions — architectural choices made (with rationale)?\n" +
    "  • observation — debugging findings, gotchas, workarounds?\n" +
    "  • projects — work-in-progress, blockers, completions?\n" +
    "If yes, call memory_store now so future sessions inherit the knowledge.";
}

/**
 * Entity-graph traversal for memory_recall.
 */
async function graphTraversal(primaryResults: QdrantPoint[], limit: number, scope: WorkspaceScope): Promise<string[]> {
  try {
    const primaryEntities = new Set<string>();
    const primaryIds = new Set<string>();
    for (const r of primaryResults) {
      primaryIds.add(r.id);
      for (const e of (r.payload.entities ?? [])) {
        primaryEntities.add(e.toLowerCase());
      }
    }

    if (primaryEntities.size === 0) return [];

    const relatedEntities = new Set<string>();
    for (const entity of primaryEntities) {
      const outgoingFilter: QdrantFilter = scopedFilter(scope, { excludeKinds: MEMORY_RECALL_EXCLUDED_KINDS }) ?? { must: [] };
      outgoingFilter.must.push({ key: "from_entity", match: { value: entity } });
      const outgoing = await qdrantScroll(outgoingFilter, 10).catch(() => ({ result: { points: [] as QdrantPoint[] } }));

      for (const pt of (outgoing.result?.points ?? [])) {
        if (pt.payload.to_entity) relatedEntities.add(pt.payload.to_entity);
      }

      const incomingFilter: QdrantFilter = scopedFilter(scope, { excludeKinds: MEMORY_RECALL_EXCLUDED_KINDS }) ?? { must: [] };
      incomingFilter.must.push({ key: "to_entity", match: { value: entity } });
      const incoming = await qdrantScroll(incomingFilter, 10).catch(() => ({ result: { points: [] as QdrantPoint[] } }));

      for (const pt of (incoming.result?.points ?? [])) {
        if (pt.payload.from_entity) relatedEntities.add(pt.payload.from_entity);
      }
    }

    for (const e of primaryEntities) relatedEntities.delete(e);
    if (relatedEntities.size === 0) return [];

    const relatedFacts: QdrantPoint[] = [];
    const maxPerEntity = Math.max(2, Math.floor(limit / relatedEntities.size));
    for (const entity of relatedEntities) {
      const filter: QdrantFilter = scopedFilter(scope, { excludeKinds: MEMORY_RECALL_EXCLUDED_KINDS }) ?? { must: [] };
      filter.must.push({ key: "entities", match: { value: entity } });
      const result = await qdrantScroll(filter, maxPerEntity).catch(() => ({ result: { points: [] as QdrantPoint[] } }));

      for (const pt of (result.result?.points ?? [])) {
        if (!primaryIds.has(pt.id)) {
          relatedFacts.push(pt);
        }
      }

      if (relatedFacts.length >= limit) break;
    }

    return relatedFacts
      .slice(0, Math.ceil(limit / 2))
      .map((r) => formatFact(r));
  } catch (e) {
    return [`(graph traversal failed: ${e instanceof Error ? e.message : String(e)})`];
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(mcp: McpServer): void {

  // ── get_setup_status ────────────────────────────────────────────────────

  mcp.tool(
    "get_setup_status",
    "Check memory system status. Returns which credentials are configured and whether Qdrant and embeddings are reachable.",
    {},
    async (): Promise<McpToolResult> => {
      const status: Record<string, unknown> = {
        ready,
        qdrant_url: !!qdrantUrl,
        qdrant_api_key: !!qdrantApiKey,
        missing: [] as string[],
        qdrant_connected: false,
        embedding_connected: false,
        embedding_provider: getEmbeddingConfig().provider,
        embedding_model: getEmbeddingConfig().model,
        embedding_dimensions: getEmbeddingConfig().dimensions,
      };
      const missing = status["missing"] as string[];
      if (!qdrantUrl) missing.push("qdrant-url");
      // qdrant-api-key is optional (local / self-hosted Qdrant doesn't need it).

      if (qdrantUrl) {
        try {
          await qdrantReq<unknown>("GET", "/collections");
          status["qdrant_connected"] = true;
        } catch { /* ignore */ }
      }
      try {
        await embed("test");
        status["embedding_connected"] = true;
      } catch { /* ignore */ }

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

  // ── configure_credentials ───────────────────────────────────────────────

  mcp.tool(
    "configure_credentials",
    "Store Qdrant + embedding credentials in ~/.bikky/config.json. Tests connectivity and creates the collection if needed.",
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
        setQdrantUrl(url);
        results["qdrant_url"] = "stored ✓";
      }

      if (qdrant_api_key) {
        cfg.qdrant_api_key = qdrant_api_key;
        setQdrantApiKey(qdrant_api_key);
        results["qdrant_api_key"] = "stored ✓";
      }

      if (openai_api_key) {
        cfg.embedding.api_key = openai_api_key;
        cfg.llm.api_key = openai_api_key;
        results["openai_api_key"] = "stored ✓";
      }

      saveConfig(cfg);

      if (qdrantUrl) {
        try {
          await ensureCollection(QDRANT_INDEXES);
          results["qdrant_collection"] = `'${getCollection()}' ready ✓`;
        } catch (e) {
          results["qdrant_collection"] = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      try {
        await embed("memory system test");
        const embCfg = getEmbeddingConfig();
        results["embedding"] = `${embCfg.provider}/${embCfg.model} (${embCfg.dimensions}d) working ✓`;
      } catch (e) {
        results["embedding"] = `error: ${e instanceof Error ? e.message : String(e)}`;
      }

      setReady(!!qdrantUrl);
      results["ready"] = ready;

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  // ── verify_connection ───────────────────────────────────────────────────

  mcp.tool(
    "verify_connection",
    "Test that Qdrant is reachable, embeddings work, and the collection exists.",
    {},
    async (): Promise<McpToolResult> => {
      const results: Record<string, unknown> = { qdrant: false, embedding: false, collection: false };

      if (qdrantUrl) {
        try {
          await qdrantReq<unknown>("GET", "/collections");
          results["qdrant"] = true;
        } catch (e) {
          results["qdrant_error"] = e instanceof Error ? e.message : String(e);
        }
        try {
          await qdrantReq<unknown>("GET", `/collections/${getCollection()}`);
          results["collection"] = true;
        } catch { /* ignore */ }
      }

      try {
        await embed("connection test");
        results["embedding"] = true;
      } catch (e) {
        results["embedding_error"] = e instanceof Error ? e.message : String(e);
      }

      const allReady = results["qdrant"] === true && results["embedding"] === true && results["collection"] === true;
      results["ready"] = allReady;
      setReady(allReady);

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );

  // ── memory_store ────────────────────────────────────────────────────────

  mcp.tool(
    "memory_store",
    "Store a new fact in memory. Automatically deduplicates via content hash and vector similarity. " +
    "Returns the action taken (inserted/reinforced/duplicate) and any similar facts found.",
    {
      content: z.string().describe("The fact to store (atomic, single piece of knowledge)"),
      category: z.enum(categoryValues())
        .describe("Subject matter: codebase, infrastructure, operations, decisions, product_domain, projects, people, preferences, observations"),
      entities: z.array(z.string()).describe("Related entities (lowercase, e.g. ['qdrant', 'platform'])"),
      domain: z.enum(domainValues()).default(DEFAULT_DOMAIN)
        .describe("Activity profile — e.g. software_engineering, product_strategy, business_operations, research, personal_productivity"),
      kind: z.enum(kindValues()).default(DEFAULT_KIND)
        .describe("Knowledge form — fact, summary, distilled, relation"),
      memory_subtype: z.enum(memorySubtypeValues()).optional()
        .describe("Optional subtype within kind, such as codebase_map, episode, workstream, convention, or recall_event"),
      workspace_id: z.string().optional()
        .describe("Optional workspace namespace for team memory."),
      episode_id: z.string().optional().describe("Optional coherent episode identifier"),
      workstream_key: z.string().optional().describe("Optional durable workstream key"),
      task_key: z.string().optional().describe("Optional task or issue key"),
      repo: z.string().optional().describe("Optional repository or project surface"),
      branch: z.string().optional().describe("Optional branch or working surface"),
      review_status: z.enum(["candidate", "reviewed", "approved", "rejected"]).optional()
        .describe("Optional review lifecycle status"),
      source: z.enum(sourceValues()).default(DEFAULT_SOURCE)
        .describe("Creator — agent, daemon, system, user"),
      confidence: z.number().min(0).max(1).default(0.9).describe("How certain (0.0-1.0)"),
      importance: z.number().min(0).max(1).optional().describe("How important (0.0-1.0). Omit to default to 0.5."),
      supersedes: z.string().optional().describe("ID of a fact this one replaces"),
      relation: z.object({
        from: z.string().describe("Source entity"),
        type: z.string().describe("Relation type (owns, uses, decided, prefers, works-on, etc.)"),
        to: z.string().describe("Target entity"),
      }).optional().describe("Optional typed relation between two entities"),
      metadata: z.record(z.string(), z.string()).optional()
        .describe("Optional key-value metadata. Stored with the fact and filterable via memory_recall."),
    },
    async ({
      content,
      category,
      entities,
      domain,
      kind,
      memory_subtype,
      workspace_id,
      episode_id,
      workstream_key,
      task_key,
      repo,
      branch,
      review_status,
      source,
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
      const scope = resolveScope(workspace_id);
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
      const redactionSummary = combineRedactions([
        redactedContent,
        ...redactedEntities,
        ...(redactedRelation ? [redactedRelation.from, redactedRelation.type, redactedRelation.to] : []),
      ]);
      const hash = contentHash(normalizedCategory, redactedContent.text);
      const normalizedEntities = sanitizedEntities.map((e) => e.toLowerCase());
      const sanitizedRelation = redactedRelation ? {
        from: redactedRelation.from.text,
        type: redactedRelation.type.text,
        to: redactedRelation.to.text,
      } : null;

      // 1. Exact dedup via content hash
      try {
        const hashFilter: QdrantFilter = scopedFilter(scope) ?? { must: [] };
        hashFilter.must.push({ key: "content_hash", match: { value: hash } });
        const existing = await qdrantScroll(hashFilter, 1);
        const existingPoint = existing.result?.points?.[0];
        if (existingPoint) {
          const point = existingPoint;
          const count = (point.payload.reinforcement_count || 1) + 1;
          await qdrantSetPayload([point.id], {
            reinforcement_count: count,
            last_reinforced_at: now,
            updated_at: now,
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
        const filter: QdrantFilter = scopedFilter(scope) ?? { must: [] };
        if (normalizedEntities.length > 0) {
          filter.must.push({ key: "entities", match: { any: normalizedEntities } });
        }

        const results = await qdrantSearch(vector, filter, 3);
        const firstResult = results.result?.[0];
        if (results.result?.length > 0 && firstResult) {
          const topScore = firstResult.score ?? 0;

          if (topScore > THRESHOLD_DUPLICATE) {
            const point = firstResult;
            const count = (point.payload.reinforcement_count || 1) + 1;
            await qdrantSetPayload([point.id], {
              reinforcement_count: count,
              last_reinforced_at: now,
              updated_at: now,
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
          const existing = await getPointForWorkspaceWrite(supersedes, scope);
          if (existing.error) {
            return { content: [{ type: "text", text: JSON.stringify(existing.error, null, 2) }], isError: true };
          }
          await qdrantSetPayload([supersedes], {
            superseded_by: factId,
            superseded_at: now,
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
        source,
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
      if (review_status) payload["review_status"] = review_status;
      addWorkspacePayload(payload, scope);
      addRedactionPayload(payload, redactionSummary);
      if (metadata && Object.keys(metadata).length > 0) {
        payload["metadata"] = metadata;
      }
      await qdrantUpsert(factId, vector, payload);

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
          source,
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
        addWorkspacePayload(relPayload, scope);
        addRedactionPayload(relPayload, redactionSummary);
        await qdrantUpsert(relationId, relVector, relPayload);
      }

      const result: Record<string, unknown> = {
        action: "inserted",
        fact_id: factId,
        workspace_id: scope.workspaceId,
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
    "Semantic search over memory. Returns facts ranked by relevance. " +
    "Use on session start with a broad query for context briefing.",
    {
      query: z.string().describe("What to search for (natural language)"),
      category: z.string().optional().describe("Filter by category"),
      domain: z.string().optional().describe("Filter by domain activity profile"),
      kind: z.string().optional().describe("Filter by kind (fact, summary, distilled, relation)"),
      memory_subtype: z.string().optional().describe("Filter by memory subtype"),
      workspace_id: z.string().optional().describe("Filter by optional workspace namespace."),
      include_legacy_workspace: z.boolean().optional()
        .describe("Include legacy facts without workspace_id in this workspace query."),
      entity: z.string().optional().describe("Filter by entity name"),
      episode_id: z.string().optional().describe("Filter by coherent episode ID"),
      workstream_key: z.string().optional().describe("Filter by durable workstream key"),
      task_key: z.string().optional().describe("Filter by task or issue key"),
      repo: z.string().optional().describe("Filter by repository or project surface"),
      branch: z.string().optional().describe("Filter by branch or working surface"),
      review_status: z.string().optional().describe("Filter by review lifecycle status"),
      since: z.string().optional().describe("Only facts created after this ISO date"),
      until: z.string().optional().describe("Only facts created before this ISO date"),
      limit: z.number().optional().default(10).describe("Max results (default 10)"),
      graph_depth: z.number().optional().default(0).describe("Entity graph traversal depth (0=none, 1=include 1-hop related entity facts)."),
      metadata_filter: z.record(z.string(), z.string()).optional()
        .describe("Filter by metadata key-value pairs. All pairs must match."),
    },
    async ({
      query,
      category,
      domain,
      kind,
      memory_subtype,
      workspace_id,
      include_legacy_workspace,
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
      metadata_filter,
    }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const requestedLimit = limit ?? 10;
      const scope = resolveScope(workspace_id, include_legacy_workspace);
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
      const filter = scopedFilter(scope, {
        category: category ? normalizeCategory(category) : undefined,
        domain: domain ? normalizeDomain(domain) : undefined,
        kind: normalizedKind,
        memory_subtype: normalizedSubtype,
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
      const results = await qdrantSearch(vector, filter, requestedLimit * 2);

      if (!results.result?.length) {
        const nudge = buildMemoryNudge();
        const text = nudge ? `No matching facts found.\n\n${nudge}` : "No matching facts found.";
        return { content: [{ type: "text", text }] };
      }

      const ranked = results.result
        .map((r) => ({ ...r, _combinedScore: computeCombinedScore(r) }))
        .sort((a, b) => b._combinedScore - a._combinedScore)
        .slice(0, requestedLimit);

      const lines = ranked.map((r) => formatFact(r));

      if ((graph_depth ?? 0) >= 1) {
        const relatedLines = await graphTraversal(ranked, requestedLimit, scope);
        if (relatedLines.length > 0) {
          lines.push("", "── Related (1-hop) ──");
          lines.push(...relatedLines);
        }
      }

      const nudge = buildMemoryNudge();
      if (nudge) lines.push("", nudge);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── memory_entity ───────────────────────────────────────────────────────

  mcp.tool(
    "memory_entity",
    "Get everything known about an entity — all facts mentioning it plus its relationships.",
    {
      name: z.string().describe("Entity name (e.g. 'qdrant', 'platform')"),
      limit: z.number().optional().default(20).describe("Max facts to return"),
      workspace_id: z.string().optional().describe("Filter by optional workspace namespace."),
      include_legacy_workspace: z.boolean().optional()
        .describe("Include legacy facts without workspace_id in this workspace query."),
    },
    async ({ name, limit, workspace_id, include_legacy_workspace }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const entityName = name.toLowerCase();
      const scope = resolveScope(workspace_id, include_legacy_workspace);

      const factsFilter: QdrantFilter = scopedFilter(scope) ?? { must: [] };
      factsFilter.must.push({ key: "entities", match: { value: entityName } });
      const facts = await qdrantScroll(factsFilter, limit ?? 20);

      const fromFilter: QdrantFilter = scopedFilter(scope) ?? { must: [] };
      fromFilter.must.push({ key: "from_entity", match: { value: entityName } });
      const relationsFrom = await qdrantScroll(fromFilter, 50);

      const toFilter: QdrantFilter = scopedFilter(scope) ?? { must: [] };
      toFilter.must.push({ key: "to_entity", match: { value: entityName } });
      const relationsTo = await qdrantScroll(toFilter, 50);

      const output: string[] = [];

      const factPoints = facts.result?.points ?? [];
      if (factPoints.length > 0) {
        output.push(`## Facts about ${name} (${factPoints.length})`);
        for (const p of factPoints) {
          if (p.payload.category !== "relation") {
            output.push(`- ${formatFact(p)}`);
          }
        }
      }

      const allRelations = [
        ...(relationsFrom.result?.points ?? []),
        ...(relationsTo.result?.points ?? []),
      ];
      const seen = new Set<string>();
      const uniqueRelations = allRelations.filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });

      if (uniqueRelations.length > 0) {
        output.push(`\n## Relations (${uniqueRelations.length})`);
        for (const r of uniqueRelations) {
          const p = r.payload;
          output.push(`- ${p.from_entity} --[${p.relation_type}]--> ${p.to_entity}`);
        }
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
    "Query entity relationships. Returns typed edges between entities.",
    {
      entity: z.string().describe("Entity name to query"),
      relation_type: z.string().optional().describe("Filter by relation type (e.g. 'owns', 'uses', 'decided')"),
      direction: z.enum(["from", "to", "both"]).optional().default("both")
        .describe("Direction: 'from' (entity as source), 'to' (entity as target), 'both'"),
      workspace_id: z.string().optional().describe("Filter by optional workspace namespace."),
      include_legacy_workspace: z.boolean().optional()
        .describe("Include legacy facts without workspace_id in this workspace query."),
    },
    async ({ entity, relation_type, direction, workspace_id, include_legacy_workspace }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const entityName = entity.toLowerCase();
      const scope = resolveScope(workspace_id, include_legacy_workspace);
      const results: QdrantPoint[] = [];

      if (direction === "from" || direction === "both") {
        const filter: QdrantFilter = scopedFilter(scope) ?? { must: [] };
        filter.must.push({ key: "from_entity", match: { value: entityName } });
        if (relation_type) {
          filter.must.push({ key: "relation_type", match: { value: relation_type.toLowerCase() } });
        }
        const r = await qdrantScroll(filter, 50);
        results.push(...(r.result?.points ?? []));
      }

      if (direction === "to" || direction === "both") {
        const filter: QdrantFilter = scopedFilter(scope) ?? { must: [] };
        filter.must.push({ key: "to_entity", match: { value: entityName } });
        if (relation_type) {
          filter.must.push({ key: "relation_type", match: { value: relation_type.toLowerCase() } });
        }
        const r = await qdrantScroll(filter, 50);
        results.push(...(r.result?.points ?? []));
      }

      const seen = new Set<string>();
      const unique = results.filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });

      if (unique.length === 0) {
        return { content: [{ type: "text", text: `No relations found for '${entity}'.` }] };
      }

      const lines = unique.map((r) => {
        const p = r.payload;
        return `${p.from_entity} --[${p.relation_type}]--> ${p.to_entity} (confidence: ${p.confidence}, id: ${r.id})`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── memory_forget ───────────────────────────────────────────────────────

  mcp.tool(
    "memory_forget",
    "Mark a fact as superseded/wrong. The fact remains but is excluded from recall results.",
    {
      fact_id: z.string().describe("ID of the fact to forget"),
      reason: z.string().describe("Why this fact is being superseded"),
      workspace_id: z.string().optional().describe("Optional workspace namespace."),
    },
    async ({ fact_id, reason, workspace_id }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const now = nowISO();
      try {
        const scope = resolveScope(workspace_id);
        const existing = await getPointForWorkspaceWrite(fact_id, scope);
        if (existing.error) {
          return { content: [{ type: "text", text: JSON.stringify(existing.error, null, 2) }], isError: true };
        }
        const redactedReason = redactStorageText(reason);
        await qdrantSetPayload([fact_id], {
          superseded_by: `forgotten:${redactedReason.text}`,
          superseded_at: now,
          updated_at: now,
        });
        return { content: [{ type: "text", text: JSON.stringify({
          status: "forgotten",
          fact_id,
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
    "Confirm a fact is still accurate. Resets the staleness clock and bumps verification count.",
    {
      fact_id: z.string().describe("ID of the fact to verify"),
      workspace_id: z.string().optional().describe("Optional workspace namespace."),
    },
    async ({ fact_id, workspace_id }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const now = nowISO();
      try {
        const scope = resolveScope(workspace_id);
        const writable = await getPointForWorkspaceWrite(fact_id, scope);
        if (writable.error) {
          return { content: [{ type: "text", text: JSON.stringify(writable.error, null, 2) }], isError: true };
        }
        let currentCount = 0;
        const existingPt = writable.point;
        if (existingPt) {
          currentCount = existingPt.payload.verification_count ?? 0;
        }
        const newCount = currentCount + 1;
        await qdrantSetPayload([fact_id], {
          last_verified_at: now,
          last_reinforced_at: now,
          verification_count: newCount,
          updated_at: now,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "verified",
            fact_id,
            verification_count: newCount,
            message: "Fact confirmed as still accurate. Staleness clock reset.",
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
    "Review recent daemon-extracted facts. Supports approve (verify), reject (forget), or correct (supersede with edited text).",
    {
      limit: z.number().optional().default(10).describe("Max facts to return (default 10)"),
      action: z.enum(["list", "approve", "reject", "correct"]).optional().default("list")
        .describe("Action: list, approve, reject, correct"),
      fact_id: z.string().optional().describe("Fact ID (required for approve/reject/correct)"),
      reason: z.string().optional().describe("Reason for rejection"),
      corrected_content: z.string().optional().describe("Corrected fact text (for correct action)"),
      workspace_id: z.string().optional().describe("Filter by optional workspace namespace."),
      include_legacy_workspace: z.boolean().optional()
        .describe("Include legacy facts without workspace_id in this workspace query."),
    },
    async ({ limit, action, fact_id, reason, corrected_content, workspace_id, include_legacy_workspace }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const scope = resolveScope(workspace_id, include_legacy_workspace);

      if (action === "list") {
        const filter: QdrantFilter = scopedFilter(scope) ?? { must: [] };
        filter.must.push({ key: "source", match: { value: "daemon" } });
        const result = await qdrantScroll(filter, (limit ?? 10) * 2);

        const points = (result.result?.points ?? [])
          .sort((a, b) => (b.payload.created_at ?? "").localeCompare(a.payload.created_at ?? ""))
          .slice(0, limit ?? 10);

        if (points.length === 0) {
          return { content: [{ type: "text", text: "No daemon-extracted facts found." }] };
        }

        const lines = points.map((pt) => {
          const p = pt.payload;
          return `[${p.category}] ${p.content}\n  id: ${pt.id} | confidence: ${p.confidence} | importance: ${p.importance} | entities: ${(p.entities ?? []).join(", ")} | created: ${p.created_at}`;
        });
        return { content: [{ type: "text", text: lines.join("\n\n") }] };
      }

      if (!fact_id) {
        return { content: [{ type: "text", text: "Error: fact_id is required for approve/reject/correct actions." }] };
      }

      const now = nowISO();

      if (action === "approve") {
        const writable = await getPointForWorkspaceWrite(fact_id, scope);
        if (writable.error) {
          return { content: [{ type: "text", text: JSON.stringify(writable.error, null, 2) }], isError: true };
        }
        let currentCount = 0;
        const approvePt = writable.point;
        if (approvePt) {
          currentCount = approvePt.payload.verification_count ?? 0;
        }
        await qdrantSetPayload([fact_id], {
          last_verified_at: now,
          verification_count: currentCount + 1,
          updated_at: now,
        });
        return { content: [{ type: "text", text: JSON.stringify({ status: "approved", fact_id }) }] };
      }

      if (action === "reject") {
        if (!reason) {
          return { content: [{ type: "text", text: "Error: reason is required for reject action." }] };
        }
        const writable = await getPointForWorkspaceWrite(fact_id, scope);
        if (writable.error) {
          return { content: [{ type: "text", text: JSON.stringify(writable.error, null, 2) }], isError: true };
        }
        const redactedReason = redactStorageText(reason);
        await qdrantSetPayload([fact_id], {
          superseded_by: `rejected:${redactedReason.text}`,
          superseded_at: now,
          updated_at: now,
        });
        return { content: [{ type: "text", text: JSON.stringify({
          status: "rejected",
          fact_id,
          reason: redactedReason.text,
          ...(redactedReason.redacted ? { redaction: redactedReason } : {}),
        }) }] };
      }

      if (action === "correct") {
        if (!corrected_content) {
          return { content: [{ type: "text", text: "Error: corrected_content is required for correct action." }] };
        }
        const writable = await getPointForWorkspaceWrite(fact_id, scope);
        if (writable.error) {
          return { content: [{ type: "text", text: JSON.stringify(writable.error, null, 2) }], isError: true };
        }
        const origPayload = writable.point?.payload;
        const redactedCorrected = redactStorageText(corrected_content);
        const correctionScope = origPayload?.workspace_id
          ? resolveScope(origPayload.workspace_id, false)
          : scope;

        const vector = await embed(redactedCorrected.text);
        const correctedId = crypto.randomUUID();
        const origCategory = normalizeCategory(origPayload?.category ?? DEFAULT_CATEGORY);
        const hash = contentHash(origCategory, redactedCorrected.text);
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
          source: "user",
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
        addWorkspacePayload(correctedPayload, correctionScope);
        addRedactionPayload(correctedPayload, redactedCorrected);
        await qdrantUpsert(correctedId, vector, correctedPayload);

        await qdrantSetPayload([fact_id], {
          superseded_by: correctedId,
          superseded_at: now,
          updated_at: now,
        });

        return { content: [{ type: "text", text: JSON.stringify({ status: "corrected", old_fact_id: fact_id, new_fact_id: correctedId }) }] };
      }

      return { content: [{ type: "text", text: `Unknown action: ${String(action)}` }] };
    },
  );

  // ── memory_heartbeat ────────────────────────────────────────────────────

  mcp.tool(
    "memory_heartbeat",
    "Lightweight reflection check. Returns memory nudge (if no stores in 10+ min), staleness alerts (every 3rd call), and reflection prompt.",
    {},
    async (): Promise<McpToolResult> => {
      heartbeatCount++;
      const sections: string[] = [];

      const nudge = buildMemoryNudge();
      if (nudge) sections.push(nudge);

      if (heartbeatCount % 3 === 0 && ready) {
        try {
          const staleThreshold = new Date(Date.now() - STALENESS_DAYS * 86400000).toISOString();
          const scope = resolveScope();
          const staleFilter: QdrantFilter = scopedFilter(scope) ?? { must: [] };
          staleFilter.must.push({ key: "category", match: { any: ["infrastructure", "projects", "decisions"] } });
          staleFilter.should = [
            { key: "last_reinforced_at", range: { lte: staleThreshold } },
            { is_null: { key: "last_reinforced_at" } },
          ];
          staleFilter.must_not = [
            { key: "last_verified_at", range: { gte: staleThreshold } },
          ];
          const staleResults = await qdrantScroll(
            staleFilter,
            3,
          );
          const staleFacts = staleResults.result?.points ?? [];
          if (staleFacts.length > 0) {
            const staleLines = staleFacts.map((f) => {
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
        "  1. Did you touch a service, port, config, or file path you hadn't seen before?\n" +
        "  2. Did you make a choice (library, pattern, approach) you'd want a future session to know about?\n" +
        "  3. Did you hit an error and find a workaround?\n" +
        "  4. Did the user state a preference or constraint?\n" +
        "If any answer is yes, call memory_store now — one atomic fact per item, with category/domain/entities.",
      );

      return { content: [{ type: "text", text: sections.join("\n\n") }] };
    },
  );
}
