/**
 * Memory API routes for @bikky/ui.
 * Ported from agent00 portal worker — stripped of CF Worker bindings and auth.
 */

import { Hono } from "hono";
import { createQdrantClient, buildFilter, type QdrantPoint, type QdrantFilter, type FactPayload } from "../lib/qdrant.js";
import { embed, isEmbeddingAvailable } from "../lib/embed.js";

export const memoryRoutes = new Hono();

function formatPoint(p: QdrantPoint) {
  return { id: p.id, score: p.score ?? null, ...p.payload };
}

// --- Query helpers ---

function parseLimit(raw: string | undefined, def: number, max: number): number {
  const n = parseInt(raw || String(def), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

function parseTopN(raw: string | undefined, max: number): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, max);
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

// GET /api/memory/search?q=...&category=...&entity=...&domain=...&kind=...&limit=...
memoryRoutes.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Missing query parameter 'q'" }, 400);

  if (!isEmbeddingAvailable()) {
    return c.json({ error: "Semantic search unavailable — the configured embedding provider is not browser-compatible. Configure ollama, openai, or portkey." }, 501);
  }

  const qdrant = createQdrantClient();
  const vector = await embed(q);

  const filter = buildFilter({
    category: c.req.query("category"),
    domain: c.req.query("domain"),
    kind: c.req.query("kind"),
    entity: c.req.query("entity"),
  });

  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const points = await qdrant.search(vector, filter.must.length > 0 ? filter : undefined, limit);

  return c.json({ results: points.map(formatPoint), count: points.length });
});

// GET /api/memory/browse?category=...&entity=...&kind=...&domain=...&source=...&since=...&until=...&sort=...&limit=...&offset=...
memoryRoutes.get("/browse", async (c) => {
  const qdrant = createQdrantClient();

  const filter = buildFilter({
    category: c.req.query("category"),
    domain: c.req.query("domain"),
    kind: c.req.query("kind"),
    entity: c.req.query("entity"),
    source: c.req.query("source"),
    since: c.req.query("since"),
    until: c.req.query("until"),
  });

  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const offset = c.req.query("offset") || undefined;

  const sort = c.req.query("sort");
  const orderBy = sort === "oldest"
    ? { key: "created_at", direction: "asc" as const }
    : sort === "newest"
      ? { key: "created_at", direction: "desc" as const }
      : undefined;

  const { points, nextOffset } = await qdrant.scroll(filter, limit, offset, orderBy);

  return c.json({ results: points.map(formatPoint), count: points.length, nextOffset });
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
  const body = await c.req.json<Partial<Pick<FactPayload, "content" | "category" | "domain" | "entities" | "confidence">>>();

  const qdrant = createQdrantClient();
  const existing = await qdrant.getPoints([id]);
  if (existing.length === 0) return c.json({ error: "Not found" }, 404);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.content !== undefined) updates.content = body.content;
  if (body.category !== undefined) updates.category = body.category;
  if (body.domain !== undefined) updates.domain = body.domain;
  if (body.entities !== undefined) updates.entities = body.entities.map((e: string) => e.toLowerCase());
  if (body.confidence !== undefined) updates.confidence = body.confidence;

  await qdrant.setPayload([id], updates);

  // Re-embed if content changed and embedding is available
  if (body.content && isEmbeddingAvailable()) {
    const vector = await embed(body.content);
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
  const vector = await embed(body.content);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const payload: Record<string, unknown> = {
    content: body.content,
    category: body.category,
    domain: body.domain || "work",
    kind: body.kind || "fact",
    entities: body.entities.map((e) => e.toLowerCase()),
    source: "ui",
    confidence: body.confidence ?? 0.9,
    content_hash: await hashContent(body.content),
    reinforcement_count: 0,
    last_reinforced_at: now,
    superseded_by: null,
    superseded_at: null,
    created_at: now,
    updated_at: now,
  };

  if (body.metadata) payload.metadata = body.metadata;
  if (body.from_entity) payload.from_entity = body.from_entity;
  if (body.relation_type) payload.relation_type = body.relation_type;
  if (body.to_entity) payload.to_entity = body.to_entity;

  await qdrant.upsert(id, vector, payload);
  return c.json({ ok: true, id }, 201);
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

  const safeCount = async (f: QdrantFilter) => {
    try { return await qdrant.count(f); } catch { return null; }
  };

  const [scroll, fromRels, toRels, factsTotal, fromTotal, toTotal] = await Promise.all([
    qdrant.scroll(filter, limit, offset),
    qdrant.scroll(fromFilter, relationsLimit),
    qdrant.scroll(toFilter, relationsLimit),
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

  return c.json({
    entity: name,
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

// GET /api/memory/graph?limit=&topN=&refresh=
memoryRoutes.get("/graph", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 2000, 5000);
  const topN = parseTopN(c.req.query("topN"), 1000);
  const refresh = c.req.query("refresh") === "true";

  const cacheKey = `graph:limit=${limit}:topN=${topN ?? ""}`;
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

  for (const fact of allFacts) {
    const entities = fact.payload.entities ?? [];
    const category = fact.payload.category;

    for (const e of entities) {
      const stat = entityStats.get(e) ?? { factCount: 0, categories: new Set() };
      stat.factCount++;
      if (category) stat.categories.add(category);
      entityStats.set(e, stat);
    }

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const [a, b] = [entities[i]!, entities[j]!].sort();
        const key = `${a}||${b}`;
        const existing = edgeMap.get(key);
        if (existing) { existing.weight++; }
        else { edgeMap.set(key, { source: a, target: b, weight: 1, type: "co-occurrence" }); }
      }
    }

    if (fact.payload.from_entity && fact.payload.to_entity && fact.payload.relation_type) {
      const from = fact.payload.from_entity;
      const to = fact.payload.to_entity;
      const [a, b] = [from, to].sort();
      const key = `rel:${a}||${b}||${fact.payload.relation_type}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, { source: from, target: to, weight: 2, type: fact.payload.relation_type });
      }
    }
  }

  let nodes = Array.from(entityStats.entries()).map(([id, stat]) => ({
    id, label: id, factCount: stat.factCount,
    categories: Array.from(stat.categories),
    primaryCategory: Array.from(stat.categories).sort((a, b) => a.localeCompare(b))[0] ?? "infrastructure",
  }));

  let edges = Array.from(edgeMap.values());
  const totalNodes = nodes.length;
  let nodesPruned = 0;

  if (topN !== null && nodes.length > topN) {
    nodes = [...nodes].sort((a, b) => b.factCount - a.factCount).slice(0, topN);
    const keep = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
    nodesPruned = totalNodes - nodes.length;
  }

  const payload = {
    nodes,
    edges,
    factCount: factsScanned,
    factsScanned,
    truncated,
    limit,
    topN,
    nodesPruned,
    totalNodes,
  };
  cacheSet(cacheKey, payload, GRAPH_TTL_MS);
  return c.json(payload);
});

// GET /api/memory/stats?refresh=
memoryRoutes.get("/stats", async (c) => {
  const refresh = c.req.query("refresh") === "true";
  const cacheKey = "stats";
  if (!refresh) {
    const hit = cacheGet<unknown>(cacheKey);
    if (hit) return c.json(hit);
  }

  const qdrant = createQdrantClient();

  // Safe count — returns 0 if filter field lacks a payload index
  const safeCount = async (filter?: QdrantFilter) => {
    try { return await qdrant.count(filter); } catch { return 0; }
  };

  const categories = ["infrastructure", "decisions", "observation", "preferences", "projects", "team"];
  const kinds = ["fact", "summary", "distilled", "relation"];

  // All counts in one Promise.all instead of three sequential awaits.
  const [info, catCounts, kindCounts, allCount] = await Promise.all([
    qdrant.collectionInfo(),
    Promise.all(categories.map(async (cat) => [cat, await safeCount(buildFilter({ category: cat }))] as const)),
    Promise.all(kinds.map(async (k) => [k, await safeCount(buildFilter({ kind: k }))] as const)),
    safeCount({ must: [] }),
  ]);

  const payload = {
    total: info.points_count,
    active: allCount,
    superseded: info.points_count - allCount,
    byCategory: Object.fromEntries(catCounts),
    byKind: Object.fromEntries(kindCounts),
  };
  cacheSet(cacheKey, payload, STATS_TTL_MS);
  return c.json(payload);
});

async function hashContent(content: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
