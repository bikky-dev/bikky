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

// GET /api/memory/search?q=...&category=...&entity=...&domain=...&kind=...&limit=...
memoryRoutes.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "Missing query parameter 'q'" }, 400);

  if (!isEmbeddingAvailable()) {
    return c.json({ error: "Semantic search unavailable — embedding provider is bedrock. Configure Ollama or OpenAI." }, 501);
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
    return c.json({ error: "Creating facts requires an embedding provider (Ollama or OpenAI)." }, 501);
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

// GET /api/memory/entities/:name
memoryRoutes.get("/entities/:name", async (c) => {
  const name = c.req.param("name").toLowerCase();
  const qdrant = createQdrantClient();

  const filter = buildFilter({ entity: name });
  const { points } = await qdrant.scroll(filter, 50);

  const fromFilter = { must: [
    { is_null: { key: "superseded_by" } },
    { key: "from_entity", match: { value: name } },
  ]};
  const toFilter = { must: [
    { is_null: { key: "superseded_by" } },
    { key: "to_entity", match: { value: name } },
  ]};

  const [fromRels, toRels] = await Promise.all([
    qdrant.scroll(fromFilter, 50),
    qdrant.scroll(toFilter, 50),
  ]);

  const relations = [
    ...fromRels.points.map((p) => ({
      id: p.id, from: p.payload.from_entity, type: p.payload.relation_type, to: p.payload.to_entity, content: p.payload.content,
    })),
    ...toRels.points.map((p) => ({
      id: p.id, from: p.payload.from_entity, type: p.payload.relation_type, to: p.payload.to_entity, content: p.payload.content,
    })),
  ];

  return c.json({
    entity: name, facts: points.map(formatPoint), relations,
    factCount: points.length, relationCount: relations.length,
  });
});

// GET /api/memory/shared?a=...&b=...
memoryRoutes.get("/shared", async (c) => {
  const a = c.req.query("a")?.toLowerCase();
  const b = c.req.query("b")?.toLowerCase();
  if (!a || !b) return c.json({ error: "Missing 'a' and 'b' entity parameters" }, 400);

  const qdrant = createQdrantClient();
  const filter: QdrantFilter = {
    must: [
      { is_null: { key: "superseded_by" } },
      { key: "entities", match: { value: a } },
      { key: "entities", match: { value: b } },
    ],
  };
  const { points } = await qdrant.scroll(filter, 50);

  return c.json({ entityA: a, entityB: b, facts: points.map(formatPoint), count: points.length });
});

// GET /api/memory/relations?entity=...&type=...&direction=...
memoryRoutes.get("/relations", async (c) => {
  const entity = c.req.query("entity")?.toLowerCase();
  const relationType = c.req.query("type");
  const direction = c.req.query("direction") || "both";

  if (!entity) return c.json({ error: "Missing 'entity' parameter" }, 400);

  const qdrant = createQdrantClient();
  const results: QdrantPoint[] = [];

  if (direction === "from" || direction === "both") {
    const must: Array<Record<string, unknown>> = [
      { is_null: { key: "superseded_by" } },
      { key: "from_entity", match: { value: entity } },
    ];
    if (relationType) must.push({ key: "relation_type", match: { value: relationType } });
    const { points } = await qdrant.scroll({ must } as QdrantFilter, 50);
    results.push(...points);
  }

  if (direction === "to" || direction === "both") {
    const must: Array<Record<string, unknown>> = [
      { is_null: { key: "superseded_by" } },
      { key: "to_entity", match: { value: entity } },
    ];
    if (relationType) must.push({ key: "relation_type", match: { value: relationType } });
    const { points } = await qdrant.scroll({ must } as QdrantFilter, 50);
    results.push(...points);
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
  });
});

// GET /api/memory/graph
memoryRoutes.get("/graph", async (c) => {
  const qdrant = createQdrantClient();

  const allFacts: QdrantPoint[] = [];
  let offset: string | null = null;
  const filter = buildFilter({});
  do {
    const { points, nextOffset } = await qdrant.scroll(filter, 100, offset);
    allFacts.push(...points);
    offset = nextOffset;
  } while (offset && allFacts.length < 2000);

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

  const nodes = Array.from(entityStats.entries()).map(([id, stat]) => ({
    id, label: id, factCount: stat.factCount,
    categories: Array.from(stat.categories),
    primaryCategory: Array.from(stat.categories).sort((a, b) => a.localeCompare(b))[0] ?? "infrastructure",
  }));

  return c.json({ nodes, edges: Array.from(edgeMap.values()), factCount: allFacts.length });
});

// GET /api/memory/stats
memoryRoutes.get("/stats", async (c) => {
  const qdrant = createQdrantClient();
  const info = await qdrant.collectionInfo();

  // Safe count — returns 0 if filter field lacks a payload index
  const safeCount = async (filter?: QdrantFilter) => {
    try { return await qdrant.count(filter); } catch { return 0; }
  };

  const categories = ["infrastructure", "decisions", "observation", "preferences", "projects", "team"];
  const categoryCounts: Record<string, number> = {};
  await Promise.all(categories.map(async (cat) => {
    categoryCounts[cat] = await safeCount(buildFilter({ category: cat }));
  }));

  const kinds = ["fact", "summary", "distilled", "relation"];
  const kindCounts: Record<string, number> = {};
  await Promise.all(kinds.map(async (k) => {
    kindCounts[k] = await safeCount(buildFilter({ kind: k }));
  }));

  const allCount = await safeCount({ must: [] });

  return c.json({
    total: info.points_count, active: allCount,
    superseded: info.points_count - allCount,
    byCategory: categoryCounts, byKind: kindCounts,
  });
});

async function hashContent(content: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
