/**
 * Lightweight session indexes.
 *
 * Session indexes are routing/audit records. They are not the durable project
 * memory boundary; episode and workstream summaries carry continuity.
 */
import { createHash, randomUUID } from "node:crypto";

import type { BikkyConfig } from "../config.js";
import { CAPTURE_POLICY_VERSION, DEFAULT_CAPTURE_CONTEXT, PROMPT_VERSIONS } from "./capture-policy.js";
import type { EpisodeSummaryWriteResult } from "./episode-summary.js";
import * as qdrant from "./qdrant.js";
import type { QdrantPayload } from "./qdrant.js";

export interface WorkspaceScope {
  workspaceId?: string;
  actorId?: string;
  includeLegacy?: boolean;
}

export interface RedactionSummary {
  redacted: boolean;
  summary: string;
  matches: Array<{ type: string; count: number }>;
}

const noRedaction = (): RedactionSummary => ({ redacted: false, summary: "none", matches: [] });
const passthroughText = (text: string, _options?: { enabled: boolean; redactPii: boolean }): { text: string; redacted: boolean; summary: string; matches: Array<{ type: string; count: number }> } => ({
  text,
  ...noRedaction(),
});
const combinePassThrough = (): RedactionSummary => noRedaction();

export interface SessionIndexDraft {
  content: string;
  episode_ids: string[];
  workstream_keys: string[];
  entities: string[];
  importance: number;
}

export interface SessionIndexPayloadResult {
  payload: Record<string, unknown>;
  redaction: RedactionSummary;
}

const contentHash = (text: string): string =>
  createHash("sha256").update(`session-index:${text}`).digest("hex");

export const buildSessionIndexDraft = (input: {
  sessionId: string;
  eventCount: number;
  episodeResults: EpisodeSummaryWriteResult[];
}): SessionIndexDraft => {
  const episodeIds = input.episodeResults
    .map((result) => result.episodeId)
    .filter((episodeId): episodeId is string => Boolean(episodeId));
  const workstreamKeys = [...new Set(input.episodeResults
    .map((result) => result.workstreamKey)
    .filter((key): key is string => Boolean(key)))];

  return {
    content: `Session ${input.sessionId} captured ${episodeIds.length} episode(s) from ${input.eventCount} event(s).`,
    episode_ids: episodeIds,
    workstream_keys: workstreamKeys,
    entities: ["bikky", "session-index", ...workstreamKeys],
    importance: 0.35,
  };
};

export const buildSessionIndexFilter = (
  sessionId: string,
  scope: WorkspaceScope,
): Record<string, unknown> => {
  const must: Record<string, unknown>[] = [
    { key: "session_id", match: { value: sessionId } },
    { key: "kind", match: { value: "summary" } },
    { key: "memory_subtype", match: { value: "session_index" } },
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

export const buildSessionIndexPayload = (input: {
  draft: SessionIndexDraft;
  sessionId: string;
  scope: WorkspaceScope;
  now: string;
  existing?: { id: string; payload?: Partial<QdrantPayload> } | null;
  eventCount: number;
  redactionOptions: { enabled: boolean; redactPii: boolean };
}): SessionIndexPayloadResult => {
  const redactedContent = passthroughText(input.draft.content, input.redactionOptions);
  const redactedEntities = input.draft.entities.map((entity) => passthroughText(entity, input.redactionOptions));
  const redaction = combinePassThrough();
  const existingPayload = input.existing?.payload ?? {};

  const payload: Record<string, unknown> = {
    ...existingPayload,
    content: redactedContent.text,
    category: "projects",
    domain: DEFAULT_CAPTURE_CONTEXT.domain,
    kind: "summary",
    memory_subtype: "session_index",
    layer: "episode",
    ...(input.scope.workspaceId ? { workspace_id: input.scope.workspaceId } : {}),
    ...(input.scope.actorId ? { actor_id: input.scope.actorId } : {}),
    entities: redactedEntities.map((entity) => entity.text.toLowerCase()),
    source: "system",
    confidence: 1.0,
    importance: input.draft.importance,
    content_hash: contentHash(redactedContent.text),
    reinforcement_count: existingPayload.reinforcement_count ?? 1,
    last_reinforced_at: existingPayload.last_reinforced_at ?? input.now,
    superseded_by: null,
    superseded_at: null,
    created_at: existingPayload.created_at ?? input.now,
    updated_at: input.now,
    session_id: input.sessionId,
    source_episode_ids: input.draft.episode_ids,
    prompt_version: PROMPT_VERSIONS.sessionIndex,
    capture_policy_version: CAPTURE_POLICY_VERSION,
    review_status: DEFAULT_CAPTURE_CONTEXT.reviewStatus,
    metadata: {
      ...(existingPayload.metadata ?? {}),
      summary_source: "daemon",
      summary_subtype: "session_index",
      summarized_from_session: input.sessionId,
      summary_event_count: String(input.eventCount),
      episode_ids: input.draft.episode_ids.join(","),
      workstream_keys: input.draft.workstream_keys.join(","),
      summary_updated_at: input.now,
    },
  };

  if (redaction.redacted) {
    payload["redaction"] = redaction;
  }

  return { payload, redaction };
};

const findExistingSessionIndex = async (
  sessionId: string,
  scope: WorkspaceScope,
): Promise<{ id: string; payload?: Partial<QdrantPayload> } | null> => {
  const result = await qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/scroll`, {
    filter: buildSessionIndexFilter(sessionId, scope),
    limit: 1,
    with_payload: true,
  }) as { result?: { points?: Array<{ id: string; payload?: Partial<QdrantPayload> }> } };

  return result.result?.points?.[0] ?? null;
};

export const updateSessionIndex = async (input: {
  sessionId: string;
  eventCount: number;
  episodeResults: EpisodeSummaryWriteResult[];
  scope: WorkspaceScope;
  config: BikkyConfig;
}): Promise<{ action: "stored" | "updated" | "skipped"; factId?: string; reason?: string }> => {
  if (input.episodeResults.length === 0) {
    return { action: "skipped", reason: "no_episode_results" };
  }
  const existing = await findExistingSessionIndex(input.sessionId, input.scope);
  const draft = buildSessionIndexDraft({
    sessionId: input.sessionId,
    eventCount: input.eventCount,
    episodeResults: input.episodeResults,
  });
  const now = new Date().toISOString();
  const { payload } = buildSessionIndexPayload({
    draft,
    sessionId: input.sessionId,
    scope: input.scope,
    now,
    existing,
    eventCount: input.eventCount,
    redactionOptions: {
      enabled: false,
      redactPii: false,
    },
  });
  const vector = await qdrant.embed(String(payload.content));
  const factId = existing?.id ?? randomUUID();

  await qdrant.qdrantRequest("PUT", `/collections/${qdrant.collection}/points`, {
    points: [{ id: factId, vector, payload }],
  });

  return { action: existing ? "updated" : "stored", factId };
};
