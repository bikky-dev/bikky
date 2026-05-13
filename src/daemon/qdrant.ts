/**
 * Qdrant client for the bikky daemon — direct HTTP access to Qdrant
 * (Cloud, Docker, or self-hosted).
 * Embedding is handled by ../llm/embedding (registry-based provider abstraction).
 *
 * Credentials: config file (~/.bikky/config.json) → env vars.
 * `qdrant_api_key` is optional — leave unset for unauthenticated local /
 * self-hosted instances.
 */

import { createHash, randomUUID } from "node:crypto";

import { getEffectiveDestinations, loadConfig, type Destination } from "../config.js";
import { embed, initEmbedding, getEmbeddingConfig } from "../llm/index.js";
import type { InitEmbeddingInput } from "../llm/index.js";
import { type QdrantLogLevel } from "../lib/qdrant-client.js";
import { QdrantPool } from "../lib/qdrant-pool.js";
import { buildResolver, type RoutingInput } from "../routing.js";
import {
  DEFAULT_DOMAIN,
  QDRANT_INDEXES,
  categoryForMemorySubtype,
  layerForMemorySubtype,
  normalizeCategory,
  normalizeDomain,
  normalizeKind,
  validateMemorySubtype,
} from "../mcp/taxonomy.js";
import {
  combineRedactions,
  redactStorageText,
  type RedactionSummary,
} from "../privacy/redaction.js";
import { buildOperationOrigin, type OperationOrigin } from "../provenance/origin.js";
import { buildMemoryRoutingInput, mergeRoutingInputs } from "../routing-context.js";

// ---------------------------------------------------------------------------
// Types (local)
// ---------------------------------------------------------------------------

export type LogFn = (level: string, ...args: unknown[]) => void;

export interface QdrantPayload {
  content: string;
  category: string;
  domain: string;
  kind: string;
  layer?: string | null;
  memory_subtype?: string | null;
  origin?: OperationOrigin;
  last_operation_origin?: OperationOrigin;
  /** @deprecated Origin is canonical for new writes. */
  workspace_id?: string;
  /** @deprecated Origin is canonical for new writes. */
  actor_id?: string;
  entities: string[];
  /** @deprecated Origin is canonical for new writes. */
  source?: string;
  confidence: number;
  importance: number;
  content_hash: string;
  reinforcement_count: number;
  last_reinforced_at: string;
  superseded_by: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string | number | boolean | null>;
  session_id?: string | null;
  episode_id?: string | null;
  workstream_key?: string | null;
  task_key?: string | null;
  repo?: string | null;
  branch?: string | null;
  surface?: string | null;
  issue_id?: string | null;
  pr_id?: string | null;
  source_event_ids?: string[];
  source_fact_ids?: string[];
  source_episode_ids?: string[];
  prompt_version?: string | null;
  capture_policy_version?: string | null;
  review_status?: string | null;
  volatility?: string | null;
  valid_from?: string | null;
  expires_at?: string | null;
  quality_score?: number | null;
  confidence_reason?: string | null;
  redaction?: RedactionSummary;
  from_entity?: string;
  relation_type?: string;
  to_entity?: string;
}

export interface StoreFact {
  content: string;
  category: string;
  domain?: string;
  kind?: string;
  layer?: string | null;
  memory_subtype?: string | null;
  entities: string[];
  origin?: OperationOrigin;
  last_operation_origin?: OperationOrigin;
  /** @deprecated Origin is canonical for new writes. */
  source?: string;
  confidence?: number;
  importance?: number;
  content_hash: string;
  workspace_id?: string;
  /** @deprecated Origin is canonical for new writes. */
  actor_id?: string;
  metadata?: Record<string, string | number | boolean | null>;
  session_id?: string | null;
  episode_id?: string | null;
  workstream_key?: string | null;
  task_key?: string | null;
  repo?: string | null;
  branch?: string | null;
  surface?: string | null;
  issue_id?: string | null;
  pr_id?: string | null;
  source_event_ids?: string[];
  source_fact_ids?: string[];
  source_episode_ids?: string[];
  prompt_version?: string | null;
  capture_policy_version?: string | null;
  review_status?: string | null;
  volatility?: string | null;
  valid_from?: string | null;
  expires_at?: string | null;
  quality_score?: number | null;
  confidence_reason?: string | null;
  relation?: { from: string; type: string; to: string } | null;
}

export interface QdrantSearchResult {
  id: string;
  destination?: string;
  score: number;
  content: string;
  category: string;
  entities: string[];
  confidence: number;
  last_reinforced_at: string;
  created_at: string;
}

export interface QdrantScrollResult {
  id: string;
  destination?: string;
  content: string;
  category: string;
  entities: string[];
  confidence: number;
  last_reinforced_at: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string | number | boolean | null>;
  session_id?: string | null;
  workstream_key?: string | null;
  task_key?: string | null;
  repo?: string | null;
  branch?: string | null;
  source_fact_ids?: string[];
}

export interface QdrantSearchFilters {
  category?: string;
  entity?: string;
  since?: string;
  domain?: string;
  source?: string;
  workspaceId?: string;
}

export interface QdrantScrollFilters {
  categories?: string[];
  olderThan?: string;
  sinceUpdated?: string;
  domain?: string;
  entity?: string;
  kinds?: string[];
  excludeKinds?: string[];
  source?: string;
  workspaceId?: string;
  orderBy?: { key: "created_at" | "updated_at" | "last_reinforced_at"; direction: "asc" | "desc" };
}

export type DedupAction = "insert" | "skip" | "supersede";

export interface DedupResult {
  action: DedupAction;
  destination?: string;
  existingId?: string;
  existingCount?: number;
  score?: number;
}

export interface DedupThresholds {
  exactThreshold?: number;
  supersedeThreshold?: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let collection: string = "bikky";
let logFn: LogFn = () => {};
let destinations: Destination[] = [];
let pool: QdrantPool | null = null;
let resolver: ((input: RoutingInput) => Destination) | null = null;

const setLogger = (fn: LogFn): void => { logFn = fn; };
const setEmbeddingConfig = (overrides?: Partial<InitEmbeddingInput>): void => {
  if (overrides && overrides.provider) initEmbedding(overrides as InitEmbeddingInput);
};

const clientLogAdapter = (level: QdrantLogLevel, msg: string): void => logFn(level, msg);

type DestinationRef = Destination | string | null | undefined;

const fallbackDestination = (): Destination => {
  if (destinations.length === 0) {
    throw new Error("Qdrant client not initialized — call init() first");
  }
  return destinations.find((destination) => destination.default === true) ?? destinations[0]!;
};

const resolveDestination = (input: RoutingInput = {}): Destination => {
  if (!resolver) return fallbackDestination();
  return resolver(input);
};

const destinationFromRef = (ref?: DestinationRef): Destination => {
  if (!ref) return fallbackDestination();
  if (typeof ref !== "string") return ref;
  const found = destinations.find((destination) => destination.name === ref);
  if (!found) {
    throw new Error(`Unknown Qdrant destination '${ref}'. Configured destinations: ${destinations.map((d) => d.name).join(", ") || "(none)"}`);
  }
  return found;
};

const pathForDestination = (urlPath: string, destination: Destination): string => {
  if (!urlPath.startsWith("/collections/")) return urlPath;
  return urlPath.replace(/^\/collections\/[^/]+/, `/collections/${destination.collection}`);
};

const routingInputForFact = (
  fact: StoreFact,
  normalizedContent: string,
  normalizedEntities: string[],
  extraMetadata: Record<string, unknown> = {},
): RoutingInput => {
  const metadata = {
    ...(fact.metadata ?? {}),
    ...extraMetadata,
    category: fact.category,
    domain: fact.domain ?? DEFAULT_DOMAIN,
    kind: fact.kind ?? "fact",
    ...(fact.memory_subtype ? { memory_subtype: fact.memory_subtype } : {}),
    ...(fact.source ? { source: fact.source } : {}),
    ...(fact.actor_id ? { actor_id: fact.actor_id } : {}),
    ...(fact.session_id ? { session_id: fact.session_id } : {}),
    ...(fact.episode_id ? { episode_id: fact.episode_id } : {}),
    ...(fact.workstream_key ? { workstream_key: fact.workstream_key } : {}),
    ...(fact.task_key ? { task_key: fact.task_key } : {}),
    ...(fact.repo ? { repo: fact.repo } : {}),
    ...(fact.branch ? { branch: fact.branch } : {}),
    ...(fact.surface ? { surface: fact.surface } : {}),
    ...(fact.issue_id ? { issue_id: fact.issue_id } : {}),
    ...(fact.pr_id ? { pr_id: fact.pr_id } : {}),
    ...(fact.source_event_ids ? { source_event_ids: fact.source_event_ids } : {}),
    ...(fact.source_fact_ids ? { source_fact_ids: fact.source_fact_ids } : {}),
    ...(fact.source_episode_ids ? { source_episode_ids: fact.source_episode_ids } : {}),
    ...(fact.prompt_version ? { prompt_version: fact.prompt_version } : {}),
    ...(fact.capture_policy_version ? { capture_policy_version: fact.capture_policy_version } : {}),
    ...(fact.review_status ? { review_status: fact.review_status } : {}),
    ...(fact.volatility ? { volatility: fact.volatility } : {}),
    ...(fact.valid_from ? { valid_from: fact.valid_from } : {}),
    ...(fact.expires_at ? { expires_at: fact.expires_at } : {}),
    ...(fact.confidence_reason ? { confidence_reason: fact.confidence_reason } : {}),
    ...(fact.relation ? {
      from_entity: fact.relation.from,
      relation_type: fact.relation.type,
      to_entity: fact.relation.to,
    } : {}),
  };
  return buildMemoryRoutingInput({
    content: normalizedContent,
    entities: normalizedEntities,
    metadata,
    extraContent: [fact.relation],
  });
};

// ---------------------------------------------------------------------------
// Init — reads credentials from loadConfig()
// ---------------------------------------------------------------------------

const init = (): boolean => {
  const cfg = loadConfig();

  destinations = getEffectiveDestinations(cfg);
  collection = (destinations.find((destination) => destination.default === true) ?? destinations[0])?.collection
    ?? cfg.collection
    ?? "bikky";

  // Initialize embedding provider from config
  const embCfg = initEmbedding({
    provider: cfg.embedding.provider,
    baseUrl: cfg.embedding.base_url,
    model: cfg.embedding.model,
    dimensions: cfg.embedding.dimensions,
    apiKey: cfg.embedding.api_key,
    extra: cfg.embedding.extra ?? {},
    timeoutMs: cfg.embedding.timeout_ms,
    retries: cfg.embedding.retries,
    retryBaseDelayMs: cfg.embedding.retry_base_delay_ms,
  });
  logFn("INFO", `Embedding provider: ${embCfg.provider}/${embCfg.model} (${embCfg.dimensions}d) @ ${embCfg.baseUrl}`);

  const ready = destinations.length > 0;
  if (ready) {
    pool = new QdrantPool(destinations, {
      client: cfg.qdrant_client,
      log: clientLogAdapter,
    });
    resolver = buildResolver(destinations);
    logFn("INFO", `Qdrant destinations: ${destinations.map((destination) => `${destination.name}/${destination.collection}`).join(", ")}`);
  } else {
    pool = null;
    resolver = null;
    logFn("WARN", "Qdrant client: missing URL (some memory features disabled)");
  }
  return ready;
};

const isReady = (): boolean => !!(pool && destinations.length > 0);

const ensureCollection = async (): Promise<void> => {
  if (!pool) {
    throw new Error("Qdrant client not initialized — call init() first");
  }
  const embCfg = getEmbeddingConfig();
  const results = await Promise.all(destinations.map(async (destination) => {
    try {
      await pool!.ensureCollection(destination.name, embCfg.dimensions, QDRANT_INDEXES);
      logFn("INFO", `Qdrant destination '${destination.name}' collection '${destination.collection}' ready (${QDRANT_INDEXES.length} indexes)`);
      return { destination, ok: true, error: null as string | null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logFn("WARN", `Qdrant destination '${destination.name}' readiness check failed: ${message}`);
      return { destination, ok: false, error: message };
    }
  }));
  if (!results.some((result) => result.ok)) {
    throw new Error(`No Qdrant destinations ready: ${results.map((result) => `${result.destination.name}: ${result.error}`).join("; ")}`);
  }
};


// ---------------------------------------------------------------------------
// HTTP requests
// ---------------------------------------------------------------------------

const qdrantRequest = async (
  method: string,
  urlPath: string,
  body?: unknown,
  destinationRef?: DestinationRef,
): Promise<Record<string, unknown>> => {
  if (!pool) {
    throw new Error(`Qdrant client not initialized — call init() first (${method} ${urlPath})`);
  }
  const destination = destinationFromRef(destinationRef);
  const result = await pool.client(destination.name).request<Record<string, unknown> | undefined>(
    method,
    pathForDestination(urlPath, destination),
    body,
  );
  // Some Qdrant endpoints return empty bodies on success — preserve old return shape.
  return result ?? {};
};

const collectionForDestination = (destinationRef?: DestinationRef): string =>
  destinationFromRef(destinationRef).collection;

const destinationNames = (): string[] => destinations.map((destination) => destination.name);

const readyDestinations = (): Destination[] => {
  if (!pool) return [];
  return destinations.filter((destination) => pool!.isCollectionReady(destination.name));
};

const activeDestinations = (): Destination[] => {
  const ready = readyDestinations();
  return ready.length > 0 ? ready : destinations;
};

// ---------------------------------------------------------------------------
// Read methods
// ---------------------------------------------------------------------------

const searchFacts = async (
  query: string,
  filters: QdrantSearchFilters = {},
  limit = 10,
  destinationRef?: DestinationRef,
): Promise<QdrantSearchResult[]> => {
  const destination = destinationFromRef(destinationRef);
  const vector = await embed(query);

  const must: Record<string, unknown>[] = [
    { is_null: { key: "superseded_by" } },
  ];

  if (filters.category) {
    must.push({ key: "category", match: { value: filters.category } });
  }
  if (filters.entity) {
    must.push({ key: "entities", match: { value: filters.entity } });
  }
  if (filters.since) {
    must.push({ key: "created_at", range: { gte: filters.since } });
  }
  if (filters.domain) {
    must.push({ key: "domain", match: { value: filters.domain } });
  }
  if (filters.source) {
    must.push({ key: "source", match: { value: filters.source } });
  }
  if (filters.workspaceId) {
    must.push({ key: "workspace_id", match: { value: filters.workspaceId } });
  }

  const result = await qdrantRequest("POST", `/collections/${destination.collection}/points/search`, {
    vector,
    filter: { must },
    limit,
    with_payload: true,
  }, destination) as { result?: Array<{ id: string; score: number; payload?: Partial<QdrantPayload> }> };

  return (result.result || []).map((hit) => ({
    id: hit.id,
    destination: destination.name,
    score: hit.score,
    content: hit.payload?.content ?? "",
    category: hit.payload?.category ?? "",
    entities: hit.payload?.entities || [],
    confidence: hit.payload?.confidence ?? 0,
    last_reinforced_at: hit.payload?.last_reinforced_at ?? "",
    created_at: hit.payload?.created_at ?? "",
  }));
};

const scrollFacts = async (
  filters: QdrantScrollFilters = {},
  limit = 10,
  destinationRef?: DestinationRef,
): Promise<QdrantScrollResult[]> => {
  const destination = destinationFromRef(destinationRef);
  const must: Record<string, unknown>[] = [
    { is_null: { key: "superseded_by" } },
  ];
  // Entity-type points live in the same collection (Phase 5a) but are NOT
  // facts. Exclude them from any fact-oriented scroll.
  const must_not: Record<string, unknown>[] = [
    { key: "kind", match: { value: "entity_type" } },
  ];

  if (filters.categories && filters.categories.length > 0) {
    must.push({
      key: "category",
      match: { any: filters.categories },
    });
  }

  if (filters.olderThan) {
    must.push({
      key: "last_reinforced_at",
      range: { lt: filters.olderThan },
    });
  }

  if (filters.sinceUpdated) {
    must.push({
      key: "updated_at",
      range: { gte: filters.sinceUpdated },
    });
  }

  if (filters.domain) {
    must.push({ key: "domain", match: { value: filters.domain } });
  }
  if (filters.entity) {
    must.push({ key: "entities", match: { value: filters.entity } });
  }
  if (filters.kinds && filters.kinds.length > 0) {
    must.push({
      key: "kind",
      match: { any: filters.kinds },
    });
  }
  for (const kind of filters.excludeKinds ?? []) {
    must_not.push({ key: "kind", match: { value: kind } });
  }
  if (filters.source) {
    must.push({ key: "source", match: { value: filters.source } });
  }
  if (filters.workspaceId) {
    must.push({ key: "workspace_id", match: { value: filters.workspaceId } });
  }
  const result = await qdrantRequest("POST", `/collections/${destination.collection}/points/scroll`, {
    filter: { must, must_not },
    limit,
    ...(filters.orderBy ? { order_by: { key: filters.orderBy.key, direction: filters.orderBy.direction } } : {}),
    with_payload: true,
  }, destination) as { result?: { points?: Array<{ id: string; payload?: Partial<QdrantPayload> }> } };

  return (result.result?.points || []).map((pt) => ({
    id: pt.id,
    destination: destination.name,
    content: pt.payload?.content ?? "",
    category: pt.payload?.category ?? "",
    entities: pt.payload?.entities || [],
    confidence: pt.payload?.confidence ?? 0,
    last_reinforced_at: pt.payload?.last_reinforced_at ?? "",
    created_at: pt.payload?.created_at ?? "",
    updated_at: pt.payload?.updated_at ?? pt.payload?.created_at ?? "",
    metadata: pt.payload?.metadata ?? {},
    session_id: pt.payload?.session_id ?? null,
    workstream_key: pt.payload?.workstream_key ?? null,
    task_key: pt.payload?.task_key ?? null,
    repo: pt.payload?.repo ?? null,
    branch: pt.payload?.branch ?? null,
    source_fact_ids: pt.payload?.source_fact_ids ?? [],
  }));
};

const scrollFactsAcrossDestinations = async (
  filters: QdrantScrollFilters = {},
  limit = 10,
): Promise<QdrantScrollResult[]> => {
  const results = await Promise.all(activeDestinations().map((destination) =>
    scrollFacts(filters, limit, destination).catch((e) => {
      logFn("WARN", `Qdrant scroll failed for destination '${destination.name}': ${(e as Error).message}`);
      return [] as QdrantScrollResult[];
    }),
  ));
  return results.flat();
};

// ---------------------------------------------------------------------------
// Write methods
// ---------------------------------------------------------------------------

const storeFact = async (fact: StoreFact, routeInput?: RoutingInput): Promise<string> => {
  const normalizedKind = normalizeKind(fact.kind);
  const normalizedSubtype = validateMemorySubtype(normalizedKind, fact.memory_subtype);
  const normalizedCategory = normalizedSubtype
    ? categoryForMemorySubtype(normalizedSubtype) ?? normalizeCategory(fact.category)
    : normalizeCategory(fact.category);
  const normalizedDomain = normalizeDomain(fact.domain ?? DEFAULT_DOMAIN);
  const normalizedLayer = fact.layer ?? (normalizedSubtype ? layerForMemorySubtype(normalizedSubtype) : null);
  const redactedContent = redactStorageText(fact.content);
  const redactedEntities = (fact.entities || []).map((entity) => redactStorageText(entity));
  const redactedRelation = fact.relation ? {
    from: redactStorageText(fact.relation.from),
    type: redactStorageText(fact.relation.type),
    to: redactStorageText(fact.relation.to),
  } : null;
  const redaction = combineRedactions([
    redactedContent,
    ...redactedEntities,
    ...(redactedRelation ? [redactedRelation.from, redactedRelation.type, redactedRelation.to] : []),
  ]);
  const now = new Date().toISOString();
  const id = randomUUID();
  const origin = fact.origin ?? buildOperationOrigin({
    interface: "daemon",
    action: "create",
    subsystem: "qdrant.store_fact",
    metadata: {
      category: normalizedCategory,
      kind: normalizedKind,
      ...(normalizedSubtype ? { memory_subtype: normalizedSubtype } : {}),
    },
  });
  const payload: QdrantPayload = {
    content: redactedContent.text,
    category: normalizedCategory,
    domain: normalizedDomain,
    kind: normalizedKind,
    ...(normalizedLayer ? { layer: normalizedLayer } : {}),
    ...(normalizedSubtype ? { memory_subtype: normalizedSubtype } : {}),
    origin,
    ...(fact.last_operation_origin ? { last_operation_origin: fact.last_operation_origin } : {}),
    entities: redactedEntities.map((entity) => entity.text.toLowerCase()),
    confidence: fact.confidence ?? 0.7,
    importance: fact.importance ?? 0.5,
    content_hash: redactedContent.redacted
      ? createHash("sha256").update(redactedContent.text).digest("hex")
      : fact.content_hash,
    reinforcement_count: 1,
    last_reinforced_at: now,
    superseded_by: null,
    superseded_at: null,
    created_at: now,
    updated_at: now,
    metadata: fact.metadata || {},
    ...(fact.session_id ? { session_id: fact.session_id } : {}),
    ...(fact.episode_id ? { episode_id: fact.episode_id } : {}),
    ...(fact.workstream_key ? { workstream_key: fact.workstream_key } : {}),
    ...(fact.task_key ? { task_key: fact.task_key } : {}),
    ...(fact.repo ? { repo: fact.repo } : {}),
    ...(fact.branch ? { branch: fact.branch } : {}),
    ...(fact.surface ? { surface: fact.surface } : {}),
    ...(fact.issue_id ? { issue_id: fact.issue_id } : {}),
    ...(fact.pr_id ? { pr_id: fact.pr_id } : {}),
    ...(fact.source_event_ids ? { source_event_ids: fact.source_event_ids } : {}),
    ...(fact.source_fact_ids ? { source_fact_ids: fact.source_fact_ids } : {}),
    ...(fact.source_episode_ids ? { source_episode_ids: fact.source_episode_ids } : {}),
    ...(fact.prompt_version ? { prompt_version: fact.prompt_version } : {}),
    ...(fact.capture_policy_version ? { capture_policy_version: fact.capture_policy_version } : {}),
    ...(fact.review_status ? { review_status: fact.review_status } : {}),
    ...(fact.volatility ? { volatility: fact.volatility } : {}),
    ...(fact.valid_from ? { valid_from: fact.valid_from } : {}),
    ...(fact.expires_at ? { expires_at: fact.expires_at } : {}),
    ...(fact.quality_score != null ? { quality_score: fact.quality_score } : {}),
    ...(fact.confidence_reason ? { confidence_reason: fact.confidence_reason } : {}),
  };
  // Add relation fields if present
  if (redactedRelation) {
    payload.from_entity = redactedRelation.from.text;
    payload.relation_type = redactedRelation.type.text;
    payload.to_entity = redactedRelation.to.text;
  }
  if (redaction.redacted) {
    payload.redaction = redaction;
  }

  const destination = resolveDestination(mergeRoutingInputs(routingInputForFact(
    fact,
    redactedContent.text,
    payload.entities,
    {
      category: normalizedCategory,
      domain: normalizedDomain,
      kind: normalizedKind,
      ...(normalizedSubtype ? { memory_subtype: normalizedSubtype } : {}),
    },
  ), routeInput));
  const vector = await embed(redactedContent.text);

  await qdrantRequest("PUT", `/collections/${destination.collection}/points`, {
    points: [{ id, vector, payload }],
  }, destination);

  logFn("DEBUG", `Qdrant: stored fact ${id} in '${destination.name}' [${normalizedCategory}] ${redactedContent.text.slice(0, 60)}`);
  return id;
};

const supersedeFact = async (oldFactId: string, newFactId: string, destinationRef?: DestinationRef, origin?: OperationOrigin): Promise<void> => {
  const destination = destinationFromRef(destinationRef);
  const now = new Date().toISOString();
  await qdrantRequest("POST", `/collections/${destination.collection}/points/payload`, {
    payload: {
      superseded_by: newFactId,
      superseded_at: now,
      updated_at: now,
      last_operation_origin: origin ?? buildOperationOrigin({
        interface: "daemon",
        action: "supersede",
        subsystem: "qdrant.supersede_fact",
        metadata: { new_fact_id: newFactId },
      }),
    },
    points: [oldFactId],
  }, destination);
  logFn("DEBUG", `Qdrant: superseded fact ${oldFactId} → ${newFactId} in '${destination.name}'`);
};

const reinforceFact = async (factId: string, currentCount: number, destinationRef?: DestinationRef, origin?: OperationOrigin): Promise<void> => {
  const destination = destinationFromRef(destinationRef);
  const now = new Date().toISOString();
  await qdrantRequest("POST", `/collections/${destination.collection}/points/payload`, {
    payload: {
      reinforcement_count: (currentCount || 1) + 1,
      last_reinforced_at: now,
      updated_at: now,
      last_operation_origin: origin ?? buildOperationOrigin({
        interface: "daemon",
        action: "reinforce",
        subsystem: "qdrant.reinforce_fact",
      }),
    },
    points: [factId],
  }, destination);
  logFn("DEBUG", `Qdrant: reinforced fact ${factId} in '${destination.name}'`);
};

const dedupCheck = async (
  content: string,
  contentHashVal: string,
  { exactThreshold = 0.92, supersedeThreshold = 0.80 }: DedupThresholds = {},
  workspaceId?: string,
  routeInput?: RoutingInput,
): Promise<DedupResult> => {
  const destination = resolveDestination(routeInput ?? { content });
  // First: hash-based exact check (fast, no embedding)
  try {
    const must: Record<string, unknown>[] = [
      { key: "content_hash", match: { value: contentHashVal } },
      { is_null: { key: "superseded_by" } },
    ];
    if (workspaceId) must.push({ key: "workspace_id", match: { value: workspaceId } });
    const hashResult = await qdrantRequest("POST", `/collections/${destination.collection}/points/scroll`, {
      filter: { must },
      limit: 1,
      with_payload: true,
    }, destination) as { result?: { points?: Array<{ id: string; payload?: Partial<QdrantPayload> }> } };

    const existing = hashResult.result?.points?.[0];
    if (existing) {
      return {
        action: "skip" as DedupAction,
        destination: destination.name,
        existingId: existing.id,
        existingCount: existing.payload?.reinforcement_count || 1,
        score: 1.0,
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logFn("WARN", `Qdrant dedup hash check failed: ${msg}`);
  }

  // Second: vector similarity check
  try {
    const vector = await embed(content);
    const must: Record<string, unknown>[] = [{ is_null: { key: "superseded_by" } }];
    if (workspaceId) must.push({ key: "workspace_id", match: { value: workspaceId } });
    const searchResult = await qdrantRequest("POST", `/collections/${destination.collection}/points/search`, {
      vector,
      filter: { must },
      limit: 1,
      with_payload: true,
    }, destination) as { result?: Array<{ id: string; score: number; payload?: Partial<QdrantPayload> }> };

    const top = searchResult.result?.[0];
    if (!top) return { action: "insert", destination: destination.name };

    if (top.score >= exactThreshold) {
      return {
        action: "skip",
        destination: destination.name,
        existingId: top.id,
        existingCount: top.payload?.reinforcement_count || 1,
        score: top.score,
      };
    }

    if (top.score >= supersedeThreshold) {
      return {
        action: "supersede",
        destination: destination.name,
        existingId: top.id,
        existingCount: top.payload?.reinforcement_count || 1,
        score: top.score,
      };
    }

    return { action: "insert", destination: destination.name };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logFn("WARN", `Qdrant dedup vector check failed: ${msg}`);
    return { action: "insert", destination: destination.name }; // fail open — better to duplicate than lose
  }
};

/**
 * Check whether incoming content is similar to any fact previously marked as a
 * bad exemplar (via memory_forget). Returns the top similarity score, or null
 * if no bad exemplars are nearby.
 *
 * Bad exemplars act as a data-driven "what we've already rejected" centroid.
 * No hardcoded vocabulary — purely embedding-similarity based, and the
 * exemplar set grows organically every time a user calls memory_forget.
 */
const badExemplarCheck = async (
  content: string,
  workspaceId?: string,
  routeInput?: RoutingInput,
): Promise<{ score: number; exemplarId: string; reason?: string } | null> => {
  const destination = resolveDestination(routeInput ?? { content });
  try {
    const vector = await embed(content);
    const must: Record<string, unknown>[] = [
      { key: "is_bad_exemplar", match: { value: true } },
    ];
    if (workspaceId) must.push({ key: "workspace_id", match: { value: workspaceId } });
    const result = await qdrantRequest("POST", `/collections/${destination.collection}/points/search`, {
      vector,
      filter: { must },
      limit: 1,
      with_payload: true,
    }, destination) as { result?: Array<{ id: string; score: number; payload?: Partial<QdrantPayload> }> };
    const top = result.result?.[0];
    if (!top) return null;
    return {
      score: top.score,
      exemplarId: top.id,
      reason: (top.payload as { bad_exemplar_reason?: string } | undefined)?.bad_exemplar_reason,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logFn("WARN", `Qdrant bad-exemplar check failed: ${msg}`);
    return null; // fail open
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  init,
  isReady,
  ensureCollection,
  setLogger,
  setEmbeddingConfig,
  qdrantRequest,
  resolveDestination,
  collectionForDestination,
  destinationNames,
  readyDestinations,
  activeDestinations,
  embed,
  searchFacts,
  scrollFacts,
  scrollFactsAcrossDestinations,
  storeFact,
  supersedeFact,
  reinforceFact,
  dedupCheck,
  badExemplarCheck,
  collection,
};
