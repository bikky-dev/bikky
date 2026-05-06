/**
 * Workstream summaries.
 *
 * Workstream summaries are durable current-state records keyed by
 * workspace + repo/surface + workstream_key. They are conservative: ambiguous
 * episodes are not merged.
 */
import { createHash, randomUUID } from "node:crypto";

import type { BikkyConfig } from "../config.js";
import { chatCompletion } from "../llm/index.js";
import { workstreamSummaryPrompt } from "../prompts/index.js";
import {
  CAPTURE_POLICY_VERSION,
  CAPTURE_TRIGGERS,
  DEFAULT_CAPTURE_CONTEXT,
  PROMPT_VERSIONS,
} from "./capture-policy.js";
import type { EpisodeSummaryWriteResult } from "./episode-summary.js";
import * as qdrant from "./qdrant.js";
import type { QdrantPayload } from "./qdrant.js";
import {
  combineRedactions,
  redactStorageText,
  type RedactionSummary,
} from "../privacy/redaction.js";
import { buildOperationOrigin, type OperationOrigin } from "../provenance/origin.js";

export { buildWorkstreamSummaryMessages } from "../prompts/index.js";

export interface WorkspaceScope {
  workspaceId?: string;
  actorId?: string;
  includeLegacy?: boolean;
}

export interface WorkstreamSummaryDraft {
  content: string;
  current_decisions: string[];
  next_steps: string[];
  blockers: string[];
  entities: string[];
  importance: number;
}

export interface WorkstreamSummaryPayloadResult {
  payload: Record<string, unknown>;
  redaction: RedactionSummary;
}

export interface WorkstreamUpdateResult {
  action: "stored" | "updated" | "skipped";
  factId?: string;
  destination?: string;
  workstreamKey?: string;
  reason?: string;
}

const contentHash = (text: string): string =>
  createHash("sha256").update(`workstream:${text}`).digest("hex");

const stripJsonFence = (raw: string): string =>
  raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
};

const clampImportance = (value: unknown): number => {
  if (typeof value !== "number" || Number.isNaN(value)) return 0.8;
  return Math.min(1, Math.max(0.5, value));
};

export const groupEpisodeResultsByWorkstream = (
  episodeResults: EpisodeSummaryWriteResult[],
): Map<string, EpisodeSummaryWriteResult[]> => {
  const grouped = new Map<string, EpisodeSummaryWriteResult[]>();
  for (const result of episodeResults) {
    const key = result.workstreamKey?.trim();
    if (!key || !result.episodeId) continue;
    const existing = grouped.get(key) ?? [];
    existing.push(result);
    grouped.set(key, existing);
  }
  return grouped;
};

const groupEpisodeResultsByWorkstreamDestination = (
  episodeResults: EpisodeSummaryWriteResult[],
): Map<string, { workstreamKey: string; destination?: string; results: EpisodeSummaryWriteResult[] }> => {
  const grouped = new Map<string, { workstreamKey: string; destination?: string; results: EpisodeSummaryWriteResult[] }>();
  for (const result of episodeResults) {
    const workstreamKey = result.workstreamKey?.trim();
    if (!workstreamKey || !result.episodeId) continue;
    const destination = result.destination?.trim();
    const groupKey = `${destination ?? ""}::${workstreamKey}`;
    const existing = grouped.get(groupKey) ?? { workstreamKey, destination, results: [] };
    existing.results.push(result);
    grouped.set(groupKey, existing);
  }
  return grouped;
};

export const parseWorkstreamSummaryDraft = (raw: string): WorkstreamSummaryDraft => {
  const parsed = JSON.parse(stripJsonFence(raw)) as Record<string, unknown>;
  const contentValue = parsed.content ?? parsed.summary;
  if (typeof contentValue !== "string" || !contentValue.trim()) {
    throw new Error("Workstream summary response missing non-empty content");
  }

  return {
    content: contentValue.trim(),
    current_decisions: normalizeStringArray(parsed.current_decisions ?? parsed.decisions),
    next_steps: normalizeStringArray(parsed.next_steps ?? parsed.follow_ups),
    blockers: normalizeStringArray(parsed.blockers ?? parsed.risks),
    entities: normalizeStringArray(parsed.entities).map((entity) => entity.toLowerCase()),
    importance: clampImportance(parsed.importance),
  };
};

export const buildWorkstreamSummaryFilter = (
  workstreamKey: string,
  scope: WorkspaceScope,
  repo?: string | null,
): Record<string, unknown> => {
  const must: Record<string, unknown>[] = [
    { key: "workstream_key", match: { value: workstreamKey } },
    { key: "kind", match: { value: "summary" } },
    { key: "memory_subtype", match: { value: "workstream" } },
    { is_null: { key: "superseded_by" } },
  ];
  if (repo) {
    must.push({ key: "repo", match: { value: repo } });
  }
  const filter: Record<string, unknown> = { must };
  if (scope.workspaceId && scope.includeLegacy) {
    filter["should"] = [
      { key: "workspace_id", match: { value: scope.workspaceId } },
      { is_empty: { key: "workspace_id" } },
    ];
  } else if (scope.workspaceId) {
    must.push({ key: "workspace_id", match: { value: scope.workspaceId } });
  }
  return filter;
};

export const buildWorkstreamEpisodeFilter = (
  workstreamKey: string,
  scope: WorkspaceScope,
): Record<string, unknown> => {
  const must: Record<string, unknown>[] = [
    { key: "workstream_key", match: { value: workstreamKey } },
    { key: "kind", match: { value: "summary" } },
    { key: "memory_subtype", match: { value: "episode" } },
    { is_null: { key: "superseded_by" } },
  ];
  const filter: Record<string, unknown> = { must };
  if (scope.workspaceId && scope.includeLegacy) {
    filter["should"] = [
      { key: "workspace_id", match: { value: scope.workspaceId } },
      { is_empty: { key: "workspace_id" } },
    ];
  } else if (scope.workspaceId) {
    must.push({ key: "workspace_id", match: { value: scope.workspaceId } });
  }
  return filter;
};

export const buildWorkstreamSummaryPayload = (input: {
  draft: WorkstreamSummaryDraft;
  workstreamKey: string;
  scope: WorkspaceScope;
  now: string;
  existing?: { id: string; payload?: Partial<QdrantPayload> } | null;
  sourceEpisodeIds: string[];
  repo?: string | null;
  redactionOptions: { enabled: boolean; redactPii: boolean };
  config?: BikkyConfig;
  origin?: OperationOrigin;
}): WorkstreamSummaryPayloadResult => {
  const redactedContent = redactStorageText(input.draft.content, input.redactionOptions);
  const redactedDecisions = input.draft.current_decisions.map((decision) => redactStorageText(decision, input.redactionOptions));
  const redactedNextSteps = input.draft.next_steps.map((step) => redactStorageText(step, input.redactionOptions));
  const redactedBlockers = input.draft.blockers.map((blocker) => redactStorageText(blocker, input.redactionOptions));
  const redactedEntities = input.draft.entities.map((entity) => redactStorageText(entity, input.redactionOptions));
  const redaction = combineRedactions([
    redactedContent,
    ...redactedDecisions,
    ...redactedNextSteps,
    ...redactedBlockers,
    ...redactedEntities,
  ]);
  const existingPayload = input.existing?.payload ?? {};
  const operationOrigin = input.origin ?? buildOperationOrigin({
    interface: "daemon",
    action: input.existing ? "update" : "create",
    subsystem: "workstream_summary",
    config: input.config,
    metadata: {
      workstream_key: input.workstreamKey,
      source_episode_count: input.sourceEpisodeIds.length,
      ...(input.repo ? { repo: input.repo } : {}),
    },
  });

  const payload: Record<string, unknown> = {
    ...existingPayload,
    content: redactedContent.text,
    category: "system",
    domain: DEFAULT_CAPTURE_CONTEXT.domain,
    kind: "summary",
    memory_subtype: "workstream",
    layer: "workstream",
    ...(input.scope.workspaceId ? { workspace_id: input.scope.workspaceId } : {}),
    ...(input.repo ? { repo: input.repo } : {}),
    origin: existingPayload.origin ?? operationOrigin,
    ...(input.existing ? { last_operation_origin: operationOrigin } : {}),
    entities: redactedEntities.map((entity) => entity.text.toLowerCase()),
    confidence: 1.0,
    importance: input.draft.importance,
    content_hash: contentHash(redactedContent.text),
    reinforcement_count: existingPayload.reinforcement_count ?? 1,
    last_reinforced_at: existingPayload.last_reinforced_at ?? input.now,
    superseded_by: null,
    superseded_at: null,
    created_at: existingPayload.created_at ?? input.now,
    updated_at: input.now,
    workstream_key: input.workstreamKey,
    source_episode_ids: input.sourceEpisodeIds,
    prompt_version: PROMPT_VERSIONS.workstreamSummary,
    capture_policy_version: CAPTURE_POLICY_VERSION,
    review_status: DEFAULT_CAPTURE_CONTEXT.reviewStatus,
    current_decisions: redactedDecisions.map((decision) => decision.text),
    next_steps: redactedNextSteps.map((step) => step.text),
    blockers: redactedBlockers.map((blocker) => blocker.text),
    metadata: {
      ...(existingPayload.metadata ?? {}),
      summary_source: "system",
      summary_subtype: "workstream",
      workstream_key: input.workstreamKey,
      source_episode_ids: input.sourceEpisodeIds.join(","),
      summary_updated_at: input.now,
    },
  };

  if (redaction.redacted) {
    payload["redaction"] = redaction;
  } else {
    delete payload["redaction"];
  }

  return { payload, redaction };
};

const findExistingWorkstreamSummary = async (
  workstreamKey: string,
  scope: WorkspaceScope,
  repo?: string | null,
  destination?: string,
): Promise<{ id: string; payload?: Partial<QdrantPayload> } | null> => {
  const collection = qdrant.collectionForDestination(destination);
  const result = await qdrant.qdrantRequest("POST", `/collections/${collection}/points/scroll`, {
    filter: buildWorkstreamSummaryFilter(workstreamKey, scope, repo),
    limit: 1,
    with_payload: true,
  }, destination) as { result?: { points?: Array<{ id: string; payload?: Partial<QdrantPayload> }> } };
  return result.result?.points?.[0] ?? null;
};

const loadEpisodeSummaries = async (
  workstreamKey: string,
  scope: WorkspaceScope,
  destination?: string,
): Promise<Array<{ id: string; payload?: Partial<QdrantPayload> }>> => {
  const collection = qdrant.collectionForDestination(destination);
  const result = await qdrant.qdrantRequest("POST", `/collections/${collection}/points/scroll`, {
    filter: buildWorkstreamEpisodeFilter(workstreamKey, scope),
    limit: CAPTURE_TRIGGERS.workstreamSummary.maxEpisodesPerUpdate,
    with_payload: true,
  }, destination) as { result?: { points?: Array<{ id: string; payload?: Partial<QdrantPayload> }> } };
  return result.result?.points ?? [];
};

const summarizeWorkstream = async (input: {
  workstreamKey: string;
  existingSummary?: string | null;
  episodeSummaries: string[];
}): Promise<WorkstreamSummaryDraft> => {
  const rendered = workstreamSummaryPrompt(input);
  const result = await chatCompletion({
    ...rendered,
    telemetry: { subsystem: "summary", workstream_key: input.workstreamKey, trigger: "workstream_summary" },
  });
  if (!result) throw new Error("Workstream summary LLM returned null");
  return parseWorkstreamSummaryDraft(result);
};

export const updateWorkstreamSummaries = async (input: {
  episodeResults: EpisodeSummaryWriteResult[];
  scope: WorkspaceScope;
  config: BikkyConfig;
}): Promise<WorkstreamUpdateResult[]> => {
  const grouped = groupEpisodeResultsByWorkstreamDestination(input.episodeResults);
  if (grouped.size === 0) return [{ action: "skipped", reason: "no_workstream_keys" }];

  const results: WorkstreamUpdateResult[] = [];
  for (const { workstreamKey, destination: groupDestination } of grouped.values()) {
    const destination = groupDestination
      ?? qdrant.resolveDestination({
        content: workstreamKey,
        entities: [workstreamKey],
        metadata: {
          workstream_key: workstreamKey,
          memory_subtype: "workstream",
          kind: "summary",
          origin_interface: "daemon",
          origin_agent_type: "daemon",
        },
      }).name;
    const episodes = await loadEpisodeSummaries(workstreamKey, input.scope, destination);
    const episodeSummaries = episodes
      .map((episode) => episode.payload?.content)
      .filter((content): content is string => Boolean(content?.trim()));
    if (episodeSummaries.length < CAPTURE_TRIGGERS.workstreamSummary.minEpisodeCount) {
      results.push({ action: "skipped", reason: "not_enough_episodes", workstreamKey, destination });
      continue;
    }

    const existing = await findExistingWorkstreamSummary(workstreamKey, input.scope, null, destination);
    const draft = await summarizeWorkstream({
      workstreamKey,
      existingSummary: existing?.payload?.content ?? null,
      episodeSummaries,
    });
    const now = new Date().toISOString();
    const { payload } = buildWorkstreamSummaryPayload({
      draft,
      workstreamKey,
      scope: input.scope,
      now,
      existing,
      sourceEpisodeIds: episodes.map((episode) => episode.payload?.episode_id ?? episode.id).filter(Boolean) as string[],
      repo: null,
      config: input.config,
      redactionOptions: {
        enabled: true,
        redactPii: false,
      },
    });
    const vector = await qdrant.embed(String(payload.content));
    const factId = existing?.id ?? randomUUID();
    const collection = qdrant.collectionForDestination(destination);
    await qdrant.qdrantRequest("PUT", `/collections/${collection}/points`, {
      points: [{ id: factId, vector, payload }],
    }, destination);
    results.push({ action: existing ? "updated" : "stored", factId, workstreamKey, destination });
  }

  return results;
};
