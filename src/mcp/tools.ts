/**
 * MCP tool definitions — all 12 memory tools.
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
  sourceValues,
  DEFAULT_DOMAIN,
  DEFAULT_KIND,
  DEFAULT_SOURCE,
} from "./taxonomy.js";
import {
  contentHash,
  daysSince,
  lastActivityDate,
  computeCombinedScore,
  buildFilter,
  formatFact,
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
  chatComplete,
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
  return `🧠 Memory nudge: No memory_store calls in ${mins} minutes. ` +
    "If you've learned project facts, made key decisions, discovered service quirks, " +
    "or resolved errors — store them now so future sessions benefit.";
}

/**
 * Entity-graph traversal for memory_recall.
 */
async function graphTraversal(primaryResults: QdrantPoint[], limit: number): Promise<string[]> {
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
      const outgoing = await qdrantScroll({
        must: [
          { key: "from_entity", match: { value: entity } },
          { is_null: { key: "superseded_by" } },
        ],
      }, 10).catch(() => ({ result: { points: [] as QdrantPoint[] } }));

      for (const pt of (outgoing.result?.points ?? [])) {
        if (pt.payload.to_entity) relatedEntities.add(pt.payload.to_entity);
      }

      const incoming = await qdrantScroll({
        must: [
          { key: "to_entity", match: { value: entity } },
          { is_null: { key: "superseded_by" } },
        ],
      }, 10).catch(() => ({ result: { points: [] as QdrantPoint[] } }));

      for (const pt of (incoming.result?.points ?? [])) {
        if (pt.payload.from_entity) relatedEntities.add(pt.payload.from_entity);
      }
    }

    for (const e of primaryEntities) relatedEntities.delete(e);
    if (relatedEntities.size === 0) return [];

    const relatedFacts: QdrantPoint[] = [];
    const maxPerEntity = Math.max(2, Math.floor(limit / relatedEntities.size));
    for (const entity of relatedEntities) {
      const result = await qdrantScroll({
        must: [
          { key: "entities", match: { value: entity } },
          { is_null: { key: "superseded_by" } },
        ],
      }, maxPerEntity).catch(() => ({ result: { points: [] as QdrantPoint[] } }));

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
      if (!qdrantApiKey) missing.push("qdrant-api-key");

      if (qdrantUrl && qdrantApiKey) {
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
          "Run `bikky setup` or guide the user:\n" +
          "1. Go to cloud.qdrant.io → sign up (free tier: 1GB, no credit card)\n" +
          "2. Create a cluster → copy the REST URL and API key\n" +
          "3. Call configure_credentials with Qdrant values";
      }

      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    },
  );

  // ── configure_credentials ───────────────────────────────────────────────

  mcp.tool(
    "configure_credentials",
    "Store Qdrant + embedding credentials in ~/.bikky/config.json. Tests connectivity and creates the collection if needed.",
    {
      qdrant_url: z.string().optional().describe("Qdrant Cloud REST URL (e.g. https://xxx.cloud.qdrant.io:6333)"),
      qdrant_api_key: z.string().optional().describe("Qdrant Cloud API key"),
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

      if (qdrantUrl && qdrantApiKey) {
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

      setReady(!!(qdrantUrl && qdrantApiKey));
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

      if (qdrantUrl && qdrantApiKey) {
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
        .describe("Topic: infrastructure, decisions, observation, preferences, projects, team"),
      entities: z.array(z.string()).describe("Related entities (lowercase, e.g. ['qdrant', 'platform'])"),
      domain: z.enum(domainValues()).default(DEFAULT_DOMAIN)
        .describe("Life scope — work or personal"),
      kind: z.enum(kindValues()).default(DEFAULT_KIND)
        .describe("Knowledge form — fact, summary, distilled, relation"),
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
    async ({ content, category, entities, domain, kind, source, confidence, importance, supersedes, relation, metadata }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      lastStoreTime = Date.now();
      const now = nowISO();
      const hash = contentHash(category, content);
      const normalizedEntities = entities.map((e) => e.toLowerCase());

      // 1. Exact dedup via content hash
      try {
        const existing = await qdrantScroll(
          { must: [
            { key: "content_hash", match: { value: hash } },
            { is_null: { key: "superseded_by" } },
          ] },
          1,
        );
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
      const vector = await embed(content);

      // 3. Semantic dedup
      let similarFacts: Array<{ id: string; content: string; score: number }> = [];
      let potentialConflicts: Array<{ id: string; content: string; category: string; similarity: number; shared_entities: string[] }> = [];
      try {
        const filter = { must: [] as Array<Record<string, unknown>> };
        if (normalizedEntities.length > 0) {
          filter.must.push({ key: "entities", match: { any: normalizedEntities } });
        }
        filter.must.push({ is_null: { key: "superseded_by" } });

        const results = await qdrantSearch(vector, filter.must.length > 0 ? filter as unknown as QdrantFilter : undefined, 3);
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
        content,
        category,
        domain,
        kind,
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
      if (metadata && Object.keys(metadata).length > 0) {
        payload["metadata"] = metadata;
      }
      await qdrantUpsert(factId, vector, payload);

      // 7. Insert relation point if provided
      let relationId: string | null = null;
      if (relation) {
        relationId = newId();
        const relContent = `${relation.from} ${relation.type} ${relation.to}`;
        const relVector = await embed(relContent);
        const relPayload: Record<string, unknown> = {
          content: relContent,
          category,
          domain,
          kind: "relation",
          entities: [relation.from.toLowerCase(), relation.to.toLowerCase()],
          source,
          confidence,
          content_hash: contentHash("relation", relContent),
          reinforcement_count: 1,
          last_reinforced_at: now,
          superseded_by: null,
          superseded_at: null,
          created_at: now,
          updated_at: now,
          from_entity: relation.from.toLowerCase(),
          relation_type: relation.type.toLowerCase(),
          to_entity: relation.to.toLowerCase(),
        };
        await qdrantUpsert(relationId, relVector, relPayload);
      }

      const result: Record<string, unknown> = {
        action: "inserted",
        fact_id: factId,
      };
      if (relationId) result["relation_id"] = relationId;
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
      domain: z.string().optional().describe("Filter by domain (work or personal)"),
      kind: z.string().optional().describe("Filter by kind (fact, summary, distilled, relation)"),
      entity: z.string().optional().describe("Filter by entity name"),
      since: z.string().optional().describe("Only facts created after this ISO date"),
      until: z.string().optional().describe("Only facts created before this ISO date"),
      limit: z.number().optional().default(10).describe("Max results (default 10)"),
      graph_depth: z.number().optional().default(0).describe("Entity graph traversal depth (0=none, 1=include 1-hop related entity facts)."),
      metadata_filter: z.record(z.string(), z.string()).optional()
        .describe("Filter by metadata key-value pairs. All pairs must match."),
    },
    async ({ query, category, domain, kind, entity, since, until, limit, graph_depth, metadata_filter }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const requestedLimit = limit ?? 10;
      const vector = await embed(query);
      const filter = buildFilter({ category, domain, kind, entity, since, until, metadata: metadata_filter });
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
        const relatedLines = await graphTraversal(ranked, requestedLimit);
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
    },
    async ({ name, limit }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const entityName = name.toLowerCase();

      const facts = await qdrantScroll(
        {
          must: [
            { key: "entities", match: { value: entityName } },
            { is_null: { key: "superseded_by" } },
          ],
        },
        limit ?? 20,
      );

      const relationsFrom = await qdrantScroll(
        { must: [
          { key: "from_entity", match: { value: entityName } },
          { is_null: { key: "superseded_by" } },
        ] },
        50,
      );
      const relationsTo = await qdrantScroll(
        { must: [
          { key: "to_entity", match: { value: entityName } },
          { is_null: { key: "superseded_by" } },
        ] },
        50,
      );

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
    },
    async ({ entity, relation_type, direction }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const entityName = entity.toLowerCase();
      const results: QdrantPoint[] = [];

      if (direction === "from" || direction === "both") {
        const filter = { must: [
          { key: "from_entity", match: { value: entityName } },
          { is_null: { key: "superseded_by" } },
        ] as QdrantFilter["must"] };
        if (relation_type) {
          filter.must.push({ key: "relation_type", match: { value: relation_type.toLowerCase() } });
        }
        const r = await qdrantScroll(filter, 50);
        results.push(...(r.result?.points ?? []));
      }

      if (direction === "to" || direction === "both") {
        const filter = { must: [
          { key: "to_entity", match: { value: entityName } },
          { is_null: { key: "superseded_by" } },
        ] as QdrantFilter["must"] };
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
    },
    async ({ fact_id, reason }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const now = nowISO();
      try {
        await qdrantSetPayload([fact_id], {
          superseded_by: `forgotten:${reason}`,
          superseded_at: now,
          updated_at: now,
        });
        return { content: [{ type: "text", text: JSON.stringify({ status: "forgotten", fact_id, reason }) }] };
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
    },
    async ({ fact_id }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const now = nowISO();
      try {
        const existing = await qdrantGetPoints([fact_id]).catch(() => null);
        let currentCount = 0;
        const existingPt = existing?.result?.[0];
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
    },
    async ({ limit, action, fact_id, reason, corrected_content }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;

      if (action === "list") {
        const result = await qdrantScroll({
          must: [
            { key: "source", match: { value: "daemon" } },
            { is_null: { key: "superseded_by" } },
          ],
        }, (limit ?? 10) * 2);

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
        const existing = await qdrantGetPoints([fact_id]).catch(() => null);
        let currentCount = 0;
        const approvePt = existing?.result?.[0];
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
        await qdrantSetPayload([fact_id], {
          superseded_by: `rejected:${reason}`,
          superseded_at: now,
          updated_at: now,
        });
        return { content: [{ type: "text", text: JSON.stringify({ status: "rejected", fact_id, reason }) }] };
      }

      if (action === "correct") {
        if (!corrected_content) {
          return { content: [{ type: "text", text: "Error: corrected_content is required for correct action." }] };
        }
        const original = await qdrantGetPoints([fact_id]).catch(() => null);
        const origPayload = original?.result?.[0]?.payload;

        const vector = await embed(corrected_content);
        const correctedId = crypto.randomUUID();
        const origCategory = origPayload?.category ?? "observation";
        const hash = contentHash(origCategory, corrected_content);
        await qdrantUpsert(correctedId, vector, {
          content: corrected_content,
          category: origCategory,
          domain: origPayload?.domain ?? "work",
          kind: origPayload?.kind ?? "fact",
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
        });

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

  // ── memory_session_summary ──────────────────────────────────────────────

  mcp.tool(
    "memory_session_summary",
    "Store a compressed summary of the current session. Call before a session ends or when a major task completes. " +
    "Future sessions receive this via memory_recall('session briefing'). Idempotent per session_id.",
    {
      session_id: z.string().describe("Session UUID"),
      summary: z.string().describe("2-5 sentence compressed summary of what happened this session"),
      tasks_completed: z.array(z.string()).optional().default([]).describe("Task slugs completed"),
      decisions_made: z.array(z.string()).optional().default([]).describe("Key decisions"),
      entities_touched: z.array(z.string()).optional().default([]).describe("Entities involved (lowercase)"),
    },
    async ({ session_id, summary, tasks_completed, decisions_made, entities_touched }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const now = nowISO();
      const normalizedEntities = entities_touched.map((e) => e.toLowerCase());

      // Check for existing summary for this session
      try {
        const existing = await qdrantScroll(
          { must: [
            { key: "session_id", match: { value: session_id } },
            { key: "kind", match: { value: "summary" } },
            { is_null: { key: "superseded_by" } },
          ] },
          1,
        );
        const summaryPoint = existing.result?.points?.[0];
        if (summaryPoint) {
          const point = summaryPoint;
          const vector = await embed(summary);
          await qdrantUpsert(point.id, vector, {
            ...point.payload,
            content: summary,
            kind: "summary",
            domain: "work",
            source: "system",
            tasks_completed,
            decisions_made,
            entities: normalizedEntities,
            content_hash: contentHash("observation", summary),
            updated_at: now,
          });
          return {
            content: [{ type: "text", text: JSON.stringify({
              action: "updated", fact_id: point.id, session_id,
            }) }],
          };
        }
      } catch (e) {
        log("WARN", `Session summary lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Insert new summary
      const vector = await embed(summary);
      const factId = newId();
      await qdrantUpsert(factId, vector, {
        content: summary,
        category: "observation",
        domain: "work",
        kind: "summary",
        entities: normalizedEntities,
        source: "system",
        confidence: 1.0,
        content_hash: contentHash("observation", summary),
        reinforcement_count: 1,
        last_reinforced_at: now,
        superseded_by: null,
        superseded_at: null,
        created_at: now,
        updated_at: now,
        session_id,
        tasks_completed,
        decisions_made,
      });

      return {
        content: [{ type: "text", text: JSON.stringify({
          action: "stored", fact_id: factId, session_id,
        }) }],
      };
    },
  );

  // ── memory_distill ──────────────────────────────────────────────────────

  mcp.tool(
    "memory_distill",
    "Consolidate recent session summaries into distilled patterns. Call when 5+ session summaries exist. " +
    "Uses LLM to extract recurring patterns and key learnings, then supersedes the source summaries.",
    {
      days: z.number().optional().default(14).describe("Look-back period in days (default 14)"),
      max_summaries: z.number().optional().default(20).describe("Max summaries to consolidate"),
    },
    async ({ days, max_summaries }): Promise<McpToolResult> => {
      const guard = requireReady();
      if (guard) return guard;
      const now = nowISO();
      const daysVal = days ?? 14;
      const maxVal = max_summaries ?? 20;
      const since = new Date(Date.now() - daysVal * 86400000).toISOString();

      const summaryResults = await qdrantScroll(
        { must: [
          { key: "kind", match: { value: "summary" } },
          { key: "created_at", range: { gte: since } },
          { is_null: { key: "superseded_by" } },
        ] },
        maxVal,
      );

      const summaries = summaryResults.result?.points ?? [];

      if (summaries.length < 3) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            action: "skipped",
            reason: `Only ${summaries.length} session summaries in the last ${daysVal} days. Need at least 3.`,
          }) }],
        };
      }

      const summaryTexts = summaries.map((s, i) => {
        const p = s.payload;
        const parts = [`Session ${i + 1} (${p.created_at}):\n${p.content}`];
        if (p.tasks_completed?.length) parts.push(`Tasks: ${p.tasks_completed.join(", ")}`);
        if (p.decisions_made?.length) parts.push(`Decisions: ${p.decisions_made.join("; ")}`);
        return parts.join("\n");
      }).join("\n\n---\n\n");

      const systemPrompt =
        "You are a memory consolidation system. Given session summaries from an engineering agent, " +
        "extract recurring patterns, consolidated learnings, and key facts. Output:\n" +
        "1. Recurring patterns (things that keep coming up)\n" +
        "2. Key infrastructure/project facts learned\n" +
        "3. Decisions made and their rationale\n" +
        "4. Open issues or recurring problems\n" +
        "Be concise — one line per point. Omit ephemeral details.";

      let distilledContent: string;
      try {
        distilledContent = await chatComplete(systemPrompt, summaryTexts);
      } catch (e) {
        return { content: [{ type: "text", text: `Distillation failed: ${e instanceof Error ? e.message : String(e)}` }] };
      }

      const allEntities = [...new Set(summaries.flatMap((s) => s.payload.entities ?? []))];
      const vector = await embed(distilledContent);
      const factId = newId();
      const sourceIds = summaries.map((s) => s.id);
      await qdrantUpsert(factId, vector, {
        content: distilledContent,
        category: "observation",
        domain: "work",
        kind: "distilled",
        entities: allEntities,
        source: "system",
        confidence: 0.9,
        content_hash: contentHash("observation", distilledContent),
        reinforcement_count: 1,
        last_reinforced_at: now,
        superseded_by: null,
        superseded_at: null,
        created_at: now,
        updated_at: now,
        distilled_from: sourceIds,
        distilled_period_start: since,
        distilled_period_end: now,
        summary_count: summaries.length,
      });

      try {
        await qdrantSetPayload(sourceIds, {
          superseded_by: factId,
          superseded_at: now,
        });
      } catch (e) {
        log("WARN", `Failed to supersede some source summaries: ${e instanceof Error ? e.message : String(e)}`);
      }

      return {
        content: [{ type: "text", text: JSON.stringify({
          action: "distilled",
          fact_id: factId,
          summaries_consolidated: summaries.length,
          period: { start: since, end: now },
          entities: allEntities,
          preview: distilledContent.substring(0, 300) + (distilledContent.length > 300 ? "..." : ""),
        }, null, 2) }],
      };
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
          const staleResults = await qdrantScroll(
            { must: [
              { key: "category", match: { any: ["infrastructure", "projects", "decisions"] } },
              { is_null: { key: "superseded_by" } },
            ],
            should: [
              { key: "last_reinforced_at", range: { lte: staleThreshold } },
              { is_null: { key: "last_reinforced_at" } },
            ],
            must_not: [
              { key: "last_verified_at", range: { gte: staleThreshold } },
            ] },
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
        "🔍 **Reflect:** What have you learned, decided, or discovered since the last heartbeat? " +
        "If anything is worth persisting for future sessions, call memory_store now.",
      );

      return { content: [{ type: "text", text: sections.join("\n\n") }] };
    },
  );
}
