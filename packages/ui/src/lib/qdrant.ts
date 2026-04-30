/**
 * Qdrant REST client for @bikky/ui.
 * Ported from agent00 portal worker — adapted to use bikky config.
 */

import { loadConfig, getActiveWorkspace } from "./config.js";

// --- Types ---

export interface FactPayload {
  content: string;
  category: string;
  domain?: string;
  kind?: string;
  memory_subtype?: string | null;
  actor_id?: string;
  entities: string[];
  source?: string;
  confidence: number;
  importance?: number;
  content_hash: string;
  reinforcement_count: number;
  last_reinforced_at: string;
  last_verified_at?: string;
  verification_count?: number;
  superseded_by: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, string>;
  redaction?: {
    redacted: boolean;
    summary: string;
    matches: Array<{ type: string; count: number }>;
  } | null;
  from_entity?: string;
  relation_type?: string;
  to_entity?: string;
  session_id?: string;
  tasks_completed?: string[];
  decisions_made?: string[];
  distilled_from?: string[];
}

export interface QdrantPoint {
  id: string;
  score?: number;
  payload: FactPayload;
}

export interface FilterCondition {
  key?: string;
  match?: { value?: string | number; any?: string[] };
  range?: { gte?: string; lte?: string };
  is_null?: { key: string };
}

export interface QdrantFilter {
  must: FilterCondition[];
  should?: FilterCondition[];
  must_not?: FilterCondition[];
}

interface ScrollResult {
  result: { points: QdrantPoint[]; next_page_offset?: string | null };
}

interface SearchResult {
  result: QdrantPoint[];
}

interface CountResult {
  result: { count: number };
}

const SOURCE_FILTER_ALIASES: Record<string, string[]> = {
  agent: ["agent", "cortex"],
  system: ["system", "daemon"],
  user: ["user", "ui", "portal"],
  docs: ["docs"],
};

const CATEGORY_FILTER_ALIASES: Record<string, string[]> = {
  engineering: ["engineering", "codebase", "infrastructure", "operations", "decisions", "observations"],
  product: ["product", "product_domain", "projects"],
  human: ["human", "people", "preferences", "team"],
  system: ["system"],
};

const aliasedFilterValue = (aliases: Record<string, string[]>, value: string): { value?: string; any?: string[] } => {
  const values = aliases[value] ?? [value];
  return values.length === 1 ? { value: values[0] } : { any: values };
};

const sourceFilterValue = (source: string): { value?: string; any?: string[] } => {
  return aliasedFilterValue(SOURCE_FILTER_ALIASES, source);
};

const categoryFilterValue = (category: string): { value?: string; any?: string[] } => {
  return aliasedFilterValue(CATEGORY_FILTER_ALIASES, category);
};

const MEMORY_SUBTYPE_FILTER_ALIASES: Record<string, FilterCondition[]> = {
  convention: [
    { key: "memory_subtype", match: { value: "convention" } },
    { key: "kind", match: { value: "distilled" } },
  ],
};

const categoryFilterConditions = (categories: string[]): FilterCondition[] => {
  return categories.map((category) => ({ key: "category", match: categoryFilterValue(category) }));
};

const memorySubtypeFilterConditions = (subtypes: string[]): FilterCondition[] => {
  return subtypes.flatMap((subtype) => {
    const aliases = MEMORY_SUBTYPE_FILTER_ALIASES[subtype];
    return aliases ?? [{ key: "memory_subtype", match: { value: subtype } }];
  });
};

// --- Client ---

export class QdrantClient {
  private readonly apiKey: string | null;
  private readonly workspaceId: string | null;

  constructor(
    private url: string,
    apiKey: string | null | undefined,
    private collection: string,
    workspaceId?: string | null,
  ) {
    this.url = url.replace(/\/+$/, "");
    this.apiKey = apiKey || null;
    this.workspaceId = workspaceId?.trim() || null;
  }

  /**
   * If a workspace is active, append `workspace_id == <ws>` to the filter's
   * `must` clauses so every query is scoped to that workspace. Returns the
   * filter unchanged when no workspace is active.
   */
  private scoped(filter?: QdrantFilter): QdrantFilter | undefined {
    if (!this.workspaceId) return filter;
    const cond: FilterCondition = { key: "workspace_id", match: { value: this.workspaceId } };
    if (!filter) return { must: [cond] };
    return { ...filter, must: [...filter.must, cond] };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["api-key"] = this.apiKey;
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const opts: RequestInit = { method, headers: this.headers() };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${this.url}${path}`, opts);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Qdrant ${method} ${path} (${resp.status}): ${text.slice(0, 300)}`);
    }
    return resp.json() as Promise<T>;
  }

  async search(vector: number[], filter?: QdrantFilter, limit = 10): Promise<QdrantPoint[]> {
    const res = await this.req<SearchResult>("POST", `/collections/${this.collection}/points/search`, {
      vector, filter: this.scoped(filter), limit, with_payload: true,
    });
    return res.result;
  }

  async scroll(filter: QdrantFilter, limit = 20, offset?: string | null, orderBy?: { key: string; direction: "asc" | "desc" }): Promise<{ points: QdrantPoint[]; nextOffset: string | null }> {
    const body: Record<string, unknown> = { filter: this.scoped(filter), limit, with_payload: true };
    if (offset) body.offset = offset;
    if (orderBy) body.order_by = orderBy;
    const res = await this.req<ScrollResult>("POST", `/collections/${this.collection}/points/scroll`, body);
    return { points: res.result.points, nextOffset: res.result.next_page_offset ?? null };
  }

  async getPoints(ids: string[]): Promise<QdrantPoint[]> {
    const res = await this.req<{ result: QdrantPoint[] }>("POST", `/collections/${this.collection}/points`, {
      ids, with_payload: true,
    });
    if (!this.workspaceId) return res.result;
    // Filter by workspace post-fetch since /points doesn't accept a filter.
    return res.result.filter((p) => {
      const ws = (p.payload as unknown as { workspace_id?: string | null }).workspace_id;
      return ws === this.workspaceId;
    });
  }

  async upsert(id: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    await this.req<unknown>("PUT", `/collections/${this.collection}/points`, {
      points: [{ id, vector, payload }],
    });
  }

  async setPayload(ids: string[], payload: Record<string, unknown>): Promise<void> {
    await this.req<unknown>("POST", `/collections/${this.collection}/points/payload`, {
      points: ids, payload,
    });
  }

  async count(filter?: QdrantFilter): Promise<number> {
    const body: Record<string, unknown> = { exact: true };
    const scoped = this.scoped(filter);
    if (scoped) body.filter = scoped;
    const res = await this.req<CountResult>("POST", `/collections/${this.collection}/points/count`, body);
    return res.result.count;
  }

  async collectionInfo(): Promise<{ points_count: number; vectors_count: number }> {
    const res = await this.req<{ result: { points_count: number; vectors_count: number } }>("GET", `/collections/${this.collection}`);
    return res.result;
  }
}

// --- Filter builder ---

export function buildFilter(opts: {
  category?: string;
  categories?: string[];
  domain?: string;
  kind?: string;
  memorySubtype?: string;
  memorySubtypes?: string[];
  entity?: string;
  source?: string;
  actorId?: string;
  since?: string;
  until?: string;
  excludeSuperseded?: boolean;
  excludeEntityType?: boolean;
}): QdrantFilter {
  const must: FilterCondition[] = [];
  const should: FilterCondition[] = [];
  const must_not: FilterCondition[] = [];
  if (opts.excludeSuperseded === true) must.push({ is_null: { key: "superseded_by" } });
  if (opts.category) must.push({ key: "category", match: categoryFilterValue(opts.category) });
  if (opts.domain) must.push({ key: "domain", match: { value: opts.domain } });
  if (opts.kind) must.push({ key: "kind", match: { value: opts.kind } });
  if (opts.memorySubtype) {
    const aliases = memorySubtypeFilterConditions([opts.memorySubtype]);
    if (MEMORY_SUBTYPE_FILTER_ALIASES[opts.memorySubtype]) should.push(...aliases);
    else must.push(...aliases);
  }
  if (opts.categories?.length || opts.memorySubtypes?.length) {
    should.push(
      ...categoryFilterConditions(opts.categories ?? []),
      ...memorySubtypeFilterConditions(opts.memorySubtypes ?? []),
    );
  }
  if (opts.entity) must.push({ key: "entities", match: { value: opts.entity.toLowerCase() } });
  if (opts.source) must.push({ key: "source", match: sourceFilterValue(opts.source) });
  if (opts.actorId) must.push({ key: "actor_id", match: { value: opts.actorId } });
  if (opts.since) must.push({ key: "created_at", range: { gte: opts.since } });
  if (opts.until) must.push({ key: "created_at", range: { lte: opts.until } });
  // Phase 5a entity_type sidecar points are not user-facing facts; opt-in to exclude.
  if (opts.excludeEntityType === true && opts.kind !== "entity_type") {
    must_not.push({ key: "kind", match: { value: "entity_type" } });
  }
  const filter: QdrantFilter = { must };
  if (should.length > 0) filter.should = should;
  if (must_not.length > 0) filter.must_not = must_not;
  return filter;
}

// --- Factory ---

export function isQdrantConfigured(): boolean {
  const cfg = loadConfig();
  return Boolean(cfg.qdrant_url);
}

export function createQdrantClient(): QdrantClient {
  const cfg = loadConfig();
  if (!cfg.qdrant_url) {
    throw new QdrantNotConfiguredError();
  }
  return new QdrantClient(cfg.qdrant_url, cfg.qdrant_api_key, cfg.collection, getActiveWorkspace());
}

export class QdrantNotConfiguredError extends Error {
  constructor() {
    super("Qdrant not configured. Run `bikky setup` first.");
    this.name = "QdrantNotConfiguredError";
  }
}
