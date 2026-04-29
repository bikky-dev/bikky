/**
 * Memory API routes for @bikky/ui.
 * Ported from agent00 portal worker — stripped of CF Worker bindings and auth.
 */

import { Hono } from "hono";
import { createQdrantClient, buildFilter, type QdrantPoint, type QdrantFilter, type FactPayload } from "../lib/qdrant.js";
import { embed, isEmbeddingAvailable } from "../lib/embed.js";
import { addRedactionPayload, combineRedactions, redactStorageText } from "../lib/redaction.js";

export const memoryRoutes = new Hono();

const CATEGORY_VALUES = [
  "engineering",
  "product",
  "human",
  "system",
] as const;

const KIND_VALUES = ["fact", "summary", "distilled", "relation", "telemetry"] as const;

const MEMORY_SUBTYPE_VALUES = [
  "codebase_map",
  "architecture_decision",
  "infra_topology",
  "access_pattern",
  "operational_procedure",
  "domain_rule",
  "product_decision",
  "product_requirement",
  "user_workflow",
  "roadmap_item",
  "success_metric",
  "market_insight",
  "troubleshooting_gotcha",
  "preference",
  "person_profile",
  "ownership_note",
  "working_agreement",
  "activity_event",
  "session_index",
  "episode",
  "workstream",
  "convention",
  "recall_event",
  "feedback_event",
  "outcome_event",
  "aggregate_rollup",
] as const;

function formatPoint(p: QdrantPoint) {
  return { id: p.id, score: p.score ?? null, ...p.payload };
}

// --- Query helpers ---

function parseLimit(raw: string | undefined, def: number, max: number): number {
  const n = parseInt(raw || String(def), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function ontologyFilters(category: string | undefined, memorySubtype: string | undefined) {
  const categories = parseList(category);
  const memorySubtypes = parseList(memorySubtype);
  if (categories.length > 1 || memorySubtypes.length > 1 || (categories.length > 0 && memorySubtypes.length > 0)) {
    return { categories, memorySubtypes };
  }
  return { category: categories[0], memorySubtype: memorySubtypes[0] };
}

// --- TTL cache (module-scope, per-process) ---

interface CacheEntry<T> { value: T; expiresAt: number; }
const cache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { cache.delete(key); return null; }
  return hit.value as T;
}

function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

const STATS_TTL_MS = 30_000;
const GRAPH_TTL_MS = 60_000;
const GRAPH_DEFAULT_MAX_NODES = 75;
const GRAPH_MAX_NODES_LIMIT = 500;
const GRAPH_DEFAULT_MAX_EDGES = 300;
const GRAPH_MAX_EDGES_LIMIT = 2_000;
const GRAPH_DEFAULT_MIN_WEIGHT = 1;
const GRAPH_MAX_MIN_WEIGHT = 20;
const GRAPH_MAX_FACT_ENTITIES_FOR_CO_OCCURRENCE = 20;
const KEYWORD_SEARCH_PAGE_SIZE = 100;
const KEYWORD_SEARCH_SCAN_LIMIT = 5_000;

const keywordValueText = (value: unknown): string[] => {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(keywordValueText);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(keywordValueText);
  return [String(value)];
};

const keywordHaystack = (payload: FactPayload): string => {
  const parts: unknown[] = [
    payload.content,
    payload.category,
    payload.domain,
    payload.kind,
    payload.memory_subtype ?? undefined,
    payload.actor_id,
    payload.source,
    payload.from_entity,
    payload.relation_type,
    payload.to_entity,
    payload.session_id,
    payload.entities,
    payload.tasks_completed,
    payload.decisions_made,
    payload.distilled_from,
    payload.metadata,
    payload.redaction,
  ];
  return parts.flatMap(keywordValueText).join(" ").toLowerCase();
};

const keywordMatches = (payload: FactPayload, terms: string[]): boolean => {
  const haystack = keywordHaystack(payload);
  return terms.every((term) => haystack.includes(term));
};

const keywordSearch = async (
  qdrant: ReturnType<typeof createQdrantClient>,
  query: string,
  filter: QdrantFilter,
  limit: number,
): Promise<{ results: ReturnType<typeof formatPoint>[]; count: number }> => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches: QdrantPoint[] = [];
  let offset: string | null | undefined;
  let scanned = 0;

  do {
    const batchLimit = Math.min(KEYWORD_SEARCH_PAGE_SIZE, KEYWORD_SEARCH_SCAN_LIMIT - scanned);
    if (batchLimit <= 0) break;
    const batch = await qdrant.scroll(filter, batchLimit, offset, { key: "created_at", direction: "desc" });
    scanned += batch.points.length;
    for (const point of batch.points) {
      if (keywordMatches(point.payload, terms)) matches.push(point);
    }
    offset = batch.nextOffset;
  } while (offset && scanned < KEYWORD_SEARCH_SCAN_LIMIT);

  return {
    results: matches.slice(0, limit).map(formatPoint),
    count: matches.length,
  };
};

// GET /api/memory/search?q=...&category=...&entity=...&domain=...&kind=...&memory_subtype=...&limit=...
memoryRoutes.get("/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ error: "Missing query parameter 'q'" }, 400);

  const qdrant = createQdrantClient();
  const filter = buildFilter({
    ...ontologyFilters(c.req.query("category"), c.req.query("memory_subtype")),
    domain: c.req.query("domain"),
    kind: c.req.query("kind"),
    entity: c.req.query("entity"),
    source: c.req.query("source"),
    actorId: c.req.query("actor_id"),
    excludeEntityType: true,
  });

  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const hasFilter = filter.must.length > 0 || (filter.should?.length ?? 0) > 0 || (filter.must_not?.length ?? 0) > 0;
  if (!isEmbeddingAvailable()) {
    return c.json(await keywordSearch(qdrant, q, filter, limit));
  }

  const vector = await embed(q);
  const points = await qdrant.search(vector, hasFilter ? filter : undefined, limit);

  return c.json({ results: points.map(formatPoint), count: points.length });
});

// GET /api/memory/browse?category=...&entity=...&kind=...&memory_subtype=...&domain=...&source=...&since=...&until=...&sort=...&limit=...&offset=...
memoryRoutes.get("/browse", async (c) => {
  const qdrant = createQdrantClient();

  const filter = buildFilter({
    ...ontologyFilters(c.req.query("category"), c.req.query("memory_subtype")),
    domain: c.req.query("domain"),
    kind: c.req.query("kind"),
    entity: c.req.query("entity"),
    source: c.req.query("source"),
    actorId: c.req.query("actor_id"),
    since: c.req.query("since"),
    until: c.req.query("until"),
    excludeEntityType: true,
  });

  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const offset = c.req.query("offset") || undefined;

  const sort = c.req.query("sort");
  const orderBy = sort === "oldest"
    ? { key: "created_at", direction: "asc" as const }
    : sort === "newest"
      ? { key: "created_at", direction: "desc" as const }
      : undefined;

  const [{ points, nextOffset }, totalCount] = await Promise.all([
    qdrant.scroll(filter, limit, offset, orderBy),
    qdrant.count(filter),
  ]);

  return c.json({ results: points.map(formatPoint), count: totalCount, nextOffset });
});

// GET /api/memory/facts/:id
memoryRoutes.get("/facts/:id", async (c) => {
  const qdrant = createQdrantClient();
  const points = await qdrant.getPoints([c.req.param("id")]);
  if (points.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json(formatPoint(points[0]!));
});

// PUT /api/memory/facts/:id
memoryRoutes.put("/facts/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<Partial<Pick<FactPayload, "content" | "category" | "domain" | "entities" | "confidence" | "from_entity" | "relation_type" | "to_entity">>>();

  const qdrant = createQdrantClient();
  const existing = await qdrant.getPoints([id]);
  if (existing.length === 0) return c.json({ error: "Not found" }, 404);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const redactedContent = body.content !== undefined ? redactStorageText(body.content) : null;
  const redactedEntities = body.entities !== undefined ? body.entities.map((entity) => redactStorageText(entity)) : null;
  const redactedFromEntity = body.from_entity !== undefined ? redactStorageText(body.from_entity) : null;
  const redactedRelationType = body.relation_type !== undefined ? redactStorageText(body.relation_type) : null;
  const redactedToEntity = body.to_entity !== undefined ? redactStorageText(body.to_entity) : null;
  const redactionSummary = combineRedactions([
    redactedContent,
    ...(redactedEntities ?? []),
    redactedFromEntity,
    redactedRelationType,
    redactedToEntity,
  ]);
  if (redactedContent) {
    updates.content = redactedContent.text;
    updates.content_hash = await hashContent(redactedContent.text);
  }
  if (body.category !== undefined) updates.category = body.category;
  if (body.domain !== undefined) updates.domain = body.domain;
  if (redactedEntities !== null) updates.entities = redactedEntities.map((e) => e.text.toLowerCase());
  if (body.confidence !== undefined) updates.confidence = body.confidence;
  if (redactedFromEntity) updates.from_entity = redactedFromEntity.text;
  if (redactedRelationType) updates.relation_type = redactedRelationType.text;
  if (redactedToEntity) updates.to_entity = redactedToEntity.text;
  if (redactionSummary.redacted) {
    addRedactionPayload(updates, redactionSummary);
  } else if (redactedContent) {
    updates.redaction = null;
  }

  await qdrant.setPayload([id], updates);

  // Re-embed if content changed and embedding is available
  if (redactedContent && isEmbeddingAvailable()) {
    const vector = await embed(redactedContent.text);
    const mergedPayload = { ...existing[0]!.payload, ...updates };
    await qdrant.upsert(id, vector, mergedPayload);
  }

  return c.json({ ok: true, id });
});

// DELETE /api/memory/facts/:id (soft delete)
memoryRoutes.delete("/facts/:id", async (c) => {
  const id = c.req.param("id");
  const qdrant = createQdrantClient();

  const existing = await qdrant.getPoints([id]);
  if (existing.length === 0) return c.json({ error: "Not found" }, 404);

  await qdrant.setPayload([id], {
    superseded_by: "ui-deleted",
    superseded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return c.json({ ok: true, id });
});

// POST /api/memory/facts
memoryRoutes.post("/facts", async (c) => {
  const body = await c.req.json<{
    content: string;
    category: string;
    entities: string[];
    domain?: string;
    kind?: string;
    actor_id?: string;
    confidence?: number;
    metadata?: Record<string, string>;
    from_entity?: string;
    relation_type?: string;
    to_entity?: string;
  }>();

  if (!body.content || !body.category || !body.entities?.length) {
    return c.json({ error: "Required: content, category, entities" }, 400);
  }

  if (!isEmbeddingAvailable()) {
    return c.json({ error: "Creating facts requires a browser-compatible embedding provider (ollama, openai, or portkey)." }, 501);
  }

  const qdrant = createQdrantClient();
  const redactedContent = redactStorageText(body.content);
  const redactedEntities = body.entities.map((entity) => redactStorageText(entity));
  const redactedFromEntity = body.from_entity ? redactStorageText(body.from_entity) : null;
  const redactedRelationType = body.relation_type ? redactStorageText(body.relation_type) : null;
  const redactedToEntity = body.to_entity ? redactStorageText(body.to_entity) : null;
  const redactionSummary = combineRedactions([
    redactedContent,
    ...redactedEntities,
    redactedFromEntity,
    redactedRelationType,
    redactedToEntity,
  ]);
  const vector = await embed(redactedContent.text);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const payload: Record<string, unknown> = {
    content: redactedContent.text,
    category: body.category,
    domain: body.domain || "software_engineering",
    kind: body.kind || "fact",
    entities: redactedEntities.map((e) => e.text.toLowerCase()),
    source: "user",
    ...(body.actor_id ? { actor_id: body.actor_id } : {}),
    confidence: body.confidence ?? 0.9,
    content_hash: await hashContent(redactedContent.text),
    reinforcement_count: 0,
    last_reinforced_at: now,
    superseded_by: null,
    superseded_at: null,
    created_at: now,
    updated_at: now,
  };

  payload.metadata = { ...(body.metadata ?? {}), created_via: "ui" };
  if (redactedFromEntity) payload.from_entity = redactedFromEntity.text;
  if (redactedRelationType) payload.relation_type = redactedRelationType.text;
  if (redactedToEntity) payload.to_entity = redactedToEntity.text;
  addRedactionPayload(payload, redactionSummary);

  await qdrant.upsert(id, vector, payload);
  return c.json({ ok: true, id }, 201);
});

// GET /api/memory/entity-types?names=a,b,c
// Returns a name → type map for the requested entities. Lightweight lookup
// used by the UI to render typed chips in fact lists.
memoryRoutes.get("/entity-types", async (c) => {
  const namesParam = c.req.query("names") || "";
  const names = namesParam
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return c.json({ types: {} });
  const qdrant = createQdrantClient();
  const filter: QdrantFilter = { must: [
    { key: "kind", match: { value: "entity_type" } },
    { key: "entity_name", match: { any: names } },
  ]};
  try {
    const scroll = await qdrant.scroll(filter, Math.min(names.length, 200));
    const types: Record<string, string> = {};
    for (const p of scroll.points) {
      const payload = p.payload as unknown as { entity_name?: string; entity_type?: string };
      if (payload.entity_name && payload.entity_type) {
        types[payload.entity_name] = payload.entity_type;
      }
    }
    return c.json({ types });
  } catch {
    return c.json({ types: {} });
  }
});

// GET /api/memory/entities/:name?limit=&offset=&relationsLimit=
memoryRoutes.get("/entities/:name", async (c) => {
  const name = c.req.param("name").toLowerCase();
  const qdrant = createQdrantClient();

  const limit = parseLimit(c.req.query("limit"), 50, 200);
  const offset = c.req.query("offset") || undefined;
  const relationsLimit = parseLimit(c.req.query("relationsLimit"), 50, 200);

  const filter = buildFilter({ entity: name });
  const fromFilter: QdrantFilter = { must: [
    { is_null: { key: "superseded_by" } },
    { key: "from_entity", match: { value: name } },
  ]};
  const toFilter: QdrantFilter = { must: [
    { is_null: { key: "superseded_by" } },
    { key: "to_entity", match: { value: name } },
  ]};
  // Phase 5a: lookup the daemon-classified entity_type point, if any.
  const typeFilter: QdrantFilter = { must: [
    { key: "kind", match: { value: "entity_type" } },
    { key: "entity_name", match: { value: name } },
  ]};

  const safeCount = async (f: QdrantFilter) => {
    try { return await qdrant.count(f); } catch { return null; }
  };

  const [scroll, fromRels, toRels, typeScroll, factsTotal, fromTotal, toTotal] = await Promise.all([
    qdrant.scroll(filter, limit, offset),
    qdrant.scroll(fromFilter, relationsLimit),
    qdrant.scroll(toFilter, relationsLimit),
    qdrant.scroll(typeFilter, 1),
    safeCount(filter),
    safeCount(fromFilter),
    safeCount(toFilter),
  ]);

  const { points, nextOffset } = scroll;

  const relations = [
    ...fromRels.points.map((p) => ({
      id: p.id, from: p.payload.from_entity, type: p.payload.relation_type, to: p.payload.to_entity, content: p.payload.content,
    })),
    ...toRels.points.map((p) => ({
      id: p.id, from: p.payload.from_entity, type: p.payload.relation_type, to: p.payload.to_entity, content: p.payload.content,
    })),
  ];

  const fromTrunc = fromRels.nextOffset !== null;
  const toTrunc = toRels.nextOffset !== null;
  const relationsTotal =
    fromTotal !== null && toTotal !== null ? fromTotal + toTotal : null;

  const typePayload = typeScroll.points[0]?.payload as unknown as
    | { entity_type?: string; entity_type_confidence?: number; entity_type_reasoning?: string; classified_at?: string }
    | undefined;

  return c.json({
    entity: name,
    entityType: typePayload?.entity_type ?? null,
    entityTypeConfidence: typePayload?.entity_type_confidence ?? null,
    entityTypeReasoning: typePayload?.entity_type_reasoning ?? null,
    entityTypeClassifiedAt: typePayload?.classified_at ?? null,
    facts: points.map(formatPoint),
    relations,
    factCount: points.length,
    relationCount: relations.length,
    factsTotal,
    relationsTotal,
    factsTruncated: nextOffset !== null,
    factsNextOffset: nextOffset,
    relationsTruncated: fromTrunc || toTrunc,
    limit,
    relationsLimit,
  });
});

// GET /api/memory/shared?a=...&b=...&limit=&offset=
memoryRoutes.get("/shared", async (c) => {
  const a = c.req.query("a")?.toLowerCase();
  const b = c.req.query("b")?.toLowerCase();
  if (!a || !b) return c.json({ error: "Missing 'a' and 'b' entity parameters" }, 400);

  const qdrant = createQdrantClient();
  const limit = parseLimit(c.req.query("limit"), 50, 200);
  const offset = c.req.query("offset") || undefined;

  const filter: QdrantFilter = {
    must: [
      { is_null: { key: "superseded_by" } },
      { key: "entities", match: { value: a } },
      { key: "entities", match: { value: b } },
    ],
  };

  const [scroll, total] = await Promise.all([
    qdrant.scroll(filter, limit, offset),
    qdrant.count(filter).catch(() => null as number | null),
  ]);

  return c.json({
    entityA: a,
    entityB: b,
    facts: scroll.points.map(formatPoint),
    count: scroll.points.length,
    total,
    truncated: scroll.nextOffset !== null,
    nextOffset: scroll.nextOffset,
    limit,
  });
});

// GET /api/memory/relations?entity=...&type=...&direction=...&limit=
memoryRoutes.get("/relations", async (c) => {
  const entity = c.req.query("entity")?.toLowerCase();
  const relationType = c.req.query("type");
  const direction = c.req.query("direction") || "both";
  const limit = parseLimit(c.req.query("limit"), 50, 200);

  if (!entity) return c.json({ error: "Missing 'entity' parameter" }, 400);

  const qdrant = createQdrantClient();
  const results: QdrantPoint[] = [];
  let truncated = false;

  if (direction === "from" || direction === "both") {
    const must: Array<Record<string, unknown>> = [
      { is_null: { key: "superseded_by" } },
      { key: "from_entity", match: { value: entity } },
    ];
    if (relationType) must.push({ key: "relation_type", match: { value: relationType } });
    const { points, nextOffset } = await qdrant.scroll({ must } as QdrantFilter, limit);
    results.push(...points);
    if (nextOffset !== null) truncated = true;
  }

  if (direction === "to" || direction === "both") {
    const must: Array<Record<string, unknown>> = [
      { is_null: { key: "superseded_by" } },
      { key: "to_entity", match: { value: entity } },
    ];
    if (relationType) must.push({ key: "relation_type", match: { value: relationType } });
    const { points, nextOffset } = await qdrant.scroll({ must } as QdrantFilter, limit);
    results.push(...points);
    if (nextOffset !== null) truncated = true;
  }

  const seen = new Set<string>();
  const unique = results.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  return c.json({
    relations: unique.map((p) => ({
      id: p.id, from: p.payload.from_entity, type: p.payload.relation_type, to: p.payload.to_entity, content: p.payload.content,
    })),
    count: unique.length,
    truncated,
    limit,
  });
});

// GET /api/memory/graph?limit=&maxNodes=&maxEdges=&minWeight=&refresh=
memoryRoutes.get("/graph", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 2000, 5000);
  const maxNodes = parseLimit(c.req.query("maxNodes") ?? c.req.query("topN"), GRAPH_DEFAULT_MAX_NODES, GRAPH_MAX_NODES_LIMIT);
  const maxEdges = parseLimit(c.req.query("maxEdges"), GRAPH_DEFAULT_MAX_EDGES, GRAPH_MAX_EDGES_LIMIT);
  const minWeight = parseLimit(c.req.query("minWeight"), GRAPH_DEFAULT_MIN_WEIGHT, GRAPH_MAX_MIN_WEIGHT);
  const refresh = c.req.query("refresh") === "true";

  const cacheKey = `graph:limit=${limit}:maxNodes=${maxNodes}:maxEdges=${maxEdges}:minWeight=${minWeight}`;
  if (!refresh) {
    const hit = cacheGet<unknown>(cacheKey);
    if (hit) return c.json(hit);
  }

  const qdrant = createQdrantClient();
  const allFacts: QdrantPoint[] = [];
  let offset: string | null = null;
  const filter = buildFilter({});
  do {
    const { points, nextOffset } = await qdrant.scroll(filter, 100, offset);
    allFacts.push(...points);
    offset = nextOffset;
  } while (offset && allFacts.length < limit);

  const truncated = offset !== null;
  const factsScanned = allFacts.length;

  const entityStats = new Map<string, { factCount: number; categories: Set<string> }>();
  const edgeMap = new Map<string, { source: string; target: string; weight: number; type: string }>();
  let denseFactsSkipped = 0;
  let coOccurrenceEdgesSkipped = 0;

  const addEntityStat = (entity: string | undefined, category?: string) => {
    if (!entity) return;
    const stat = entityStats.get(entity) ?? { factCount: 0, categories: new Set() };
    stat.factCount++;
    if (category) stat.categories.add(category);
    entityStats.set(entity, stat);
  };

  for (const fact of allFacts) {
    const entities = Array.from(new Set(fact.payload.entities ?? []));
    const entitySet = new Set(entities);
    const category = fact.payload.category;

    for (const e of entities) {
      addEntityStat(e, category);
    }

    if (entities.length > GRAPH_MAX_FACT_ENTITIES_FOR_CO_OCCURRENCE) {
      denseFactsSkipped++;
      coOccurrenceEdgesSkipped += (entities.length * (entities.length - 1)) / 2;
    } else {
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const [a, b] = [entities[i]!, entities[j]!].sort();
          const key = `${a}||${b}`;
          const existing = edgeMap.get(key);
          if (existing) { existing.weight++; }
          else { edgeMap.set(key, { source: a, target: b, weight: 1, type: "co-occurrence" }); }
        }
      }
    }

    if (fact.payload.from_entity && fact.payload.to_entity && fact.payload.relation_type) {
      const from = fact.payload.from_entity;
      const to = fact.payload.to_entity;
      if (!entitySet.has(from)) addEntityStat(from, category);
      if (!entitySet.has(to)) addEntityStat(to, category);
      const [a, b] = [from, to].sort();
      const key = `rel:${a}||${b}||${fact.payload.relation_type}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += 2;
      } else {
        edgeMap.set(key, { source: from, target: to, weight: 2, type: fact.payload.relation_type });
      }
    }
  }

  let nodes = Array.from(entityStats.entries()).map(([id, stat]) => ({
    id, label: id, factCount: stat.factCount,
    categories: Array.from(stat.categories),
    primaryCategory: Array.from(stat.categories).sort((a, b) => a.localeCompare(b))[0] ?? "engineering",
  }));

  const totalNodes = nodes.length;
  nodes = [...nodes].sort((a, b) => b.factCount - a.factCount || a.id.localeCompare(b.id)).slice(0, maxNodes);
  const nodesPruned = Math.max(totalNodes - nodes.length, 0);
  const keep = new Set(nodes.map((n) => n.id));

  const nodeScopedEdges = Array.from(edgeMap.values()).filter((e) => keep.has(e.source) && keep.has(e.target));
  const weightScopedEdges = nodeScopedEdges.filter((e) => e.type !== "co-occurrence" || e.weight >= minWeight);
  const totalEdges = weightScopedEdges.length;
  const edgesFilteredByWeight = nodeScopedEdges.length - weightScopedEdges.length;
  const edges = [...weightScopedEdges]
    .sort((a, b) => {
      const aTyped = a.type !== "co-occurrence";
      const bTyped = b.type !== "co-occurrence";
      if (aTyped !== bTyped) return aTyped ? -1 : 1;
      return b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target);
    })
    .slice(0, maxEdges);
  const edgesPruned = Math.max(totalEdges - edges.length, 0);

  const payload = {
    nodes,
    edges,
    factCount: factsScanned,
    factsScanned,
    truncated,
    limit,
    topN: maxNodes,
    maxNodes,
    maxEdges,
    minWeight,
    nodesPruned,
    totalNodes,
    edgesPruned,
    totalEdges,
    edgesFilteredByWeight,
    denseFactsSkipped,
    coOccurrenceEdgesSkipped,
  };
  cacheSet(cacheKey, payload, GRAPH_TTL_MS);
  return c.json(payload);
});

// GET /api/memory/stats?kind=...&source=...&refresh=
memoryRoutes.get("/stats", async (c) => {
  const refresh = c.req.query("refresh") === "true";
  const kind = c.req.query("kind") || undefined;
  const source = c.req.query("source") || undefined;
  const statsFilter = { kind, source };
  const cacheKey = `stats:kind=${kind ?? ""}:source=${source ?? ""}`;
  if (!refresh) {
    const hit = cacheGet<unknown>(cacheKey);
    if (hit) return c.json(hit);
  }

  const qdrant = createQdrantClient();

  // Safe count — returns 0 if filter field lacks a payload index
  const safeCount = async (filter?: QdrantFilter) => {
    try { return await qdrant.count(filter); } catch { return 0; }
  };

  // All counts in one Promise.all instead of several sequential awaits.
  const [info, catCounts, kindCounts, subtypeCounts, allCount] = await Promise.all([
    qdrant.collectionInfo(),
    Promise.all(CATEGORY_VALUES.map(async (cat) => [cat, await safeCount(buildFilter({ ...statsFilter, category: cat }))] as const)),
    Promise.all(KIND_VALUES.map(async (k) => [k, await safeCount(buildFilter({ source, kind: k }))] as const)),
    Promise.all(MEMORY_SUBTYPE_VALUES.map(async (subtype) => [subtype, await safeCount(buildFilter({ ...statsFilter, memorySubtype: subtype }))] as const)),
    safeCount(buildFilter(statsFilter)),
  ]);

  const payload = {
    total: info.points_count,
    active: allCount,
    superseded: info.points_count - allCount,
    byCategory: Object.fromEntries(catCounts),
    byKind: Object.fromEntries(kindCounts),
    bySubtype: Object.fromEntries(subtypeCounts),
  };
  cacheSet(cacheKey, payload, STATS_TTL_MS);
  return c.json(payload);
});

async function hashContent(content: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
