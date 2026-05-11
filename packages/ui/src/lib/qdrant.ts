/**
 * Qdrant REST client for @bikky/ui.
 * Ported from agent00 portal worker — adapted to use bikky config.
 */

import { getDefaultDestination, getDestinationByName, getEffectiveDestinations, type UIDestination } from "./config.js";
import type { OperationOrigin } from "./origin.js";

// --- Types ---

export interface FactPayload {
  content: string;
  category: string;
  domain?: string;
  kind?: string;
  memory_subtype?: string | null;
  origin?: OperationOrigin;
  last_operation_origin?: OperationOrigin;
  /** @deprecated Origin is canonical for new writes. */
  actor_id?: string;
  entities: string[];
  /** @deprecated Origin is canonical for new writes. */
  source?: string;
  confidence: number;
  importance?: number;
  content_hash: string;
  reinforcement_count: number;
  last_reinforced_at: string;
  last_verified_at?: string;
  verification_count?: number;
  useful_count?: number;
  not_useful_count?: number;
  useful_feedback_count?: number;
  not_useful_feedback_count?: number;
  misleading_count?: number;
  wrong_count?: number;
  irrelevant_count?: number;
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
  is_empty?: { key: string };
  // Nested sub-filter — Qdrant allows must/should/must_not entries to themselves
  // be filter objects, which are AND/OR-combined like a parenthesised group.
  must?: FilterCondition[];
  should?: FilterCondition[];
  must_not?: FilterCondition[];
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

const TELEMETRY_SUBTYPES = new Set([
  "recall_event",
  "feedback_event",
  "outcome_event",
  "aggregate_rollup",
]);

const SYSTEM_SUBTYPES = new Set([
  "session_index",
  "episode",
  "workstream",
]);

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

  constructor(
    private url: string,
    apiKey: string | null | undefined,
    private collection: string,
  ) {
    this.url = url.replace(/\/+$/, "");
    this.apiKey = apiKey || null;
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
      vector, filter, limit, with_payload: true,
    });
    return res.result;
  }

  async scroll(filter: QdrantFilter, limit = 20, offset?: string | null, orderBy?: { key: string; direction: "asc" | "desc" }): Promise<{ points: QdrantPoint[]; nextOffset: string | null }> {
    const body: Record<string, unknown> = { filter, limit, with_payload: true };
    if (offset) body.offset = offset;
    if (orderBy) body.order_by = orderBy;
    const res = await this.req<ScrollResult>("POST", `/collections/${this.collection}/points/scroll`, body);
    return { points: res.result.points, nextOffset: res.result.next_page_offset ?? null };
  }

  async getPoints(ids: string[]): Promise<QdrantPoint[]> {
    const res = await this.req<{ result: QdrantPoint[] }>("POST", `/collections/${this.collection}/points`, {
      ids, with_payload: true,
    });
    return res.result;
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
    if (filter) body.filter = filter;
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
  originUserId?: string;
  originAgentId?: string;
  originInterface?: string;
  since?: string;
  until?: string;
  excludeSuperseded?: boolean;
  excludeEntityType?: boolean;
  excludeTelemetry?: boolean;
  excludeSystem?: boolean;
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
  if (opts.source) {
    must.push({
      should: [
        { key: "origin.agent.type", match: sourceFilterValue(opts.source) },
        { key: "origin.interface", match: sourceFilterValue(opts.source) },
        { key: "source", match: sourceFilterValue(opts.source) },
      ],
    });
  }
  if (opts.actorId) {
    must.push({
      should: [
        { key: "origin.user.id", match: { value: opts.actorId } },
        { key: "origin.agent.id", match: { value: opts.actorId } },
        { key: "actor_id", match: { value: opts.actorId } },
      ],
    });
  }
  if (opts.originUserId) must.push({ key: "origin.user.id", match: { value: opts.originUserId } });
  if (opts.originAgentId) must.push({ key: "origin.agent.id", match: { value: opts.originAgentId } });
  if (opts.originInterface) must.push({ key: "origin.interface", match: { value: opts.originInterface } });
  if (opts.since) must.push({ key: "created_at", range: { gte: opts.since } });
  if (opts.until) must.push({ key: "created_at", range: { lte: opts.until } });
  // Phase 5a entity_type sidecar points are not user-facing facts; opt-in to exclude.
  if (opts.excludeEntityType === true && opts.kind !== "entity_type") {
    must_not.push({ key: "kind", match: { value: "entity_type" } });
  }
  const explicitlyRequestsTelemetry = opts.kind === "telemetry"
    || (opts.memorySubtype !== undefined && TELEMETRY_SUBTYPES.has(opts.memorySubtype))
    || (opts.memorySubtypes ?? []).some((subtype) => TELEMETRY_SUBTYPES.has(subtype));
  if (opts.excludeTelemetry === true && !explicitlyRequestsTelemetry) {
    must_not.push({ key: "kind", match: { value: "telemetry" } });
  }
  const explicitlyRequestsSystem = opts.category === "system"
    || (opts.categories ?? []).includes("system")
    || (opts.memorySubtype !== undefined && SYSTEM_SUBTYPES.has(opts.memorySubtype))
    || (opts.memorySubtypes ?? []).some((subtype) => SYSTEM_SUBTYPES.has(subtype))
    || explicitlyRequestsTelemetry;
  if (opts.excludeSystem === true && !explicitlyRequestsSystem) {
    must_not.push({ key: "category", match: { value: "system" } });
    must_not.push({ key: "memory_subtype", match: { any: Array.from(SYSTEM_SUBTYPES) } });
  }
  const filter: QdrantFilter = { must };
  if (should.length > 0) filter.should = should;
  if (must_not.length > 0) filter.must_not = must_not;
  return filter;
}

// --- Factory ---

export function isQdrantConfigured(): boolean {
  return getEffectiveDestinations().length > 0;
}

/**
 * Create a Qdrant client for a specific destination.
 *
 * - Pass a destination name to target it explicitly.
 * - Pass `undefined` to use the default destination.
 * Throws QdrantNotConfiguredError if the requested destination doesn't exist
 * (or no destinations are configured at all).
 */
export function createQdrantClient(destinationName?: string): QdrantClient {
  const dest = destinationName
    ? getDestinationByName(destinationName)
    : getDefaultDestination();
  if (!dest) {
    throw new QdrantNotConfiguredError(destinationName);
  }
  return new QdrantClient(dest.qdrant_url, dest.qdrant_api_key, dest.collection);
}

/** Resolve the destinations targeted by a request. `"all"` → every destination. */
export function resolveTargetDestinations(destinationName: string | undefined): UIDestination[] {
  const all = getEffectiveDestinations();
  if (all.length === 0) throw new QdrantNotConfiguredError();
  if (!destinationName) {
    const def = getDefaultDestination();
    return def ? [def] : [];
  }
  if (destinationName === "all") return all;
  const dest = getDestinationByName(destinationName);
  if (!dest) throw new QdrantNotConfiguredError(destinationName);
  return [dest];
}

export class QdrantNotConfiguredError extends Error {
  constructor(destinationName?: string) {
    super(
      destinationName
        ? `Qdrant destination '${destinationName}' is not configured.`
        : "Qdrant not configured. Run `bikky setup` first.",
    );
    this.name = "QdrantNotConfiguredError";
  }
}
