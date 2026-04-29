/**
 * Episode summaries.
 *
 * A session can contain multiple unrelated tasks. Episodes are coherent task
 * segments inside the session and are the summary unit that feeds durable
 * workstream memory.
 */
import { createHash, randomUUID } from "node:crypto";

import type { BikkyConfig } from "../config.js";
import { normalizeEntities } from "../mcp/taxonomy.js";
import { chatCompletion } from "../llm/index.js";
import { episodeSummaryPrompt } from "../prompts/index.js";
import {
  CAPTURE_POLICY_VERSION,
  CAPTURE_TRIGGERS,
  DEFAULT_CAPTURE_CONTEXT,
  PROMPT_VERSIONS,
} from "./capture-policy.js";
import * as qdrant from "./qdrant.js";
import type { QdrantPayload } from "./qdrant.js";
import {
  combineRedactions,
  redactStorageText,
  type RedactionSummary,
} from "../privacy/redaction.js";
import {
  resolveWorkstreamKey,
  type ResolvedWorkstream,
  type WorkstreamRegistry,
} from "./workstream-resolver.js";

export { buildEpisodeSummaryMessages } from "../prompts/index.js";

export interface WorkspaceScope {
  workspaceId?: string;
  actorId?: string;
  includeLegacy?: boolean;
}

export interface EpisodeSegment {
  episode_id: string;
  ordinal: number;
  transcript: string;
  event_count: number;
  workstream_key?: string | null;
}

export interface EpisodeSummaryDraft {
  content: string;
  tasks_completed: string[];
  decisions_made: string[];
  open_questions: string[];
  entities: string[];
  workstream_key?: string | null;
  workstream_key_reason?: string | null;
  importance: number;
}

export interface EpisodeSummaryPayloadResult {
  payload: Record<string, unknown>;
  redaction: RedactionSummary;
}

export interface EpisodeSummaryWriteResult {
  action: "stored" | "updated" | "skipped";
  factId?: string;
  episodeId?: string;
  workstreamKey?: string | null;
  reason?: string;
}

const DEFAULT_EPISODE_IMPORTANCE = 0.75;

const contentHash = (text: string): string =>
  createHash("sha256").update(`episode:${text}`).digest("hex");

const stableHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

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
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_EPISODE_IMPORTANCE;
  return Math.min(1, Math.max(0.5, value));
};

const likelyUsefulEpisode = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length >= CAPTURE_TRIGGERS.episodeSummary.minUsefulCharacters) return true;
  return Boolean(
    /\b(?:decide|decided|implement|implemented|update|updated|fix|fixed|root cause|because|prefer|use|run|ran|command|error|fails|passes)\b/i.test(trimmed) &&
    /(?:`[^`]+`|(?:[\w.-]+\/)+[\w./-]+|\b(?:npm|git|gh|docker|kubectl|make|python|go|cargo|curl)\b|#\d+)/i.test(trimmed),
  );
};

export const segmentTranscriptIntoEpisodes = (input: {
  sessionId: string;
  transcript: string;
  eventCount: number;
}): EpisodeSegment[] => {
  const transcript = input.transcript.trim();
  if (!transcript) return [];

  const chunks: string[] = [];
  let current: string[] = [];
  for (const block of transcript.split(/\n{2,}/)) {
    if (/^\[USER\]/.test(block) && current.length > 0) {
      chunks.push(current.join("\n\n").trim());
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) chunks.push(current.join("\n\n").trim());

  const candidateChunks = chunks.length > 0 ? chunks : [transcript];
  const eventCountPerChunk = Math.max(1, Math.round(input.eventCount / candidateChunks.length));

  return candidateChunks
    .map((chunk, index) => ({ chunk, index }))
    .filter(({ chunk }) => likelyUsefulEpisode(chunk))
    .map(({ chunk, index }) => ({
      episode_id: `${input.sessionId}:episode:${stableHash(`${input.sessionId}:${index}:${chunk}`)}`,
      ordinal: index,
      transcript: chunk,
      event_count: eventCountPerChunk,
    }));
};

export const parseEpisodeSummaryDraft = (raw: string): EpisodeSummaryDraft => {
  const parsed = JSON.parse(stripJsonFence(raw)) as Record<string, unknown>;
  const contentValue = parsed.content ?? parsed.summary;
  if (typeof contentValue !== "string" || !contentValue.trim()) {
    throw new Error("Episode summary response missing non-empty content");
  }

  return {
    content: contentValue.trim(),
    tasks_completed: normalizeStringArray(parsed.tasks_completed ?? parsed.tasks),
    decisions_made: normalizeStringArray(parsed.decisions_made ?? parsed.decisions),
    open_questions: normalizeStringArray(parsed.open_questions ?? parsed.follow_ups),
    entities: normalizeEntities(normalizeStringArray(parsed.entities)),
    workstream_key: typeof parsed.workstream_key === "string" && parsed.workstream_key.trim()
      ? parsed.workstream_key.trim()
      : null,
    workstream_key_reason: typeof parsed.workstream_key_reason === "string" && parsed.workstream_key_reason.trim()
      ? parsed.workstream_key_reason.trim()
      : null,
    importance: clampImportance(parsed.importance),
  };
};

export const buildEpisodeSummaryFilter = (
  episodeId: string,
  scope: WorkspaceScope,
): Record<string, unknown> => {
  const must: Record<string, unknown>[] = [
    { key: "episode_id", match: { value: episodeId } },
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

export const buildEpisodeSummaryPayload = (input: {
  draft: EpisodeSummaryDraft;
  segment: EpisodeSegment;
  sessionId: string;
  scope: WorkspaceScope;
  now: string;
  existing?: { id: string; payload?: Partial<QdrantPayload> } | null;
  redactionOptions: { enabled: boolean; redactPii: boolean };
}): EpisodeSummaryPayloadResult => {
  const redactedContent = redactStorageText(input.draft.content, input.redactionOptions);
  const redactedTasks = input.draft.tasks_completed.map((task) => redactStorageText(task, input.redactionOptions));
  const redactedDecisions = input.draft.decisions_made.map((decision) => redactStorageText(decision, input.redactionOptions));
  const redactedOpenQuestions = input.draft.open_questions.map((question) => redactStorageText(question, input.redactionOptions));
  const redactedEntities = input.draft.entities.map((entity) => redactStorageText(entity, input.redactionOptions));
  const redaction = combineRedactions([
    redactedContent,
    ...redactedTasks,
    ...redactedDecisions,
    ...redactedOpenQuestions,
    ...redactedEntities,
  ]);
  const existingPayload = input.existing?.payload ?? {};
  const workstreamKey = input.draft.workstream_key ?? input.segment.workstream_key ?? null;

  const payload: Record<string, unknown> = {
    ...existingPayload,
    content: redactedContent.text,
    category: "system",
    domain: DEFAULT_CAPTURE_CONTEXT.domain,
    kind: "summary",
    memory_subtype: "episode",
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
    episode_id: input.segment.episode_id,
    ...(workstreamKey ? { workstream_key: workstreamKey } : {}),
    ...(input.draft.workstream_key_reason ? { workstream_key_reason: input.draft.workstream_key_reason } : {}),
    prompt_version: PROMPT_VERSIONS.episodeSummary,
    capture_policy_version: CAPTURE_POLICY_VERSION,
    review_status: DEFAULT_CAPTURE_CONTEXT.reviewStatus,
    tasks_completed: redactedTasks.map((task) => task.text),
    decisions_made: redactedDecisions.map((decision) => decision.text),
    open_questions: redactedOpenQuestions.map((question) => question.text),
    metadata: {
      ...(existingPayload.metadata ?? {}),
      summary_source: "system",
      summary_subtype: "episode",
      summarized_from_session: input.sessionId,
      episode_id: input.segment.episode_id,
      episode_event_count: String(input.segment.event_count),
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

const summarizeEpisodeTranscript = async (input: {
  transcript: string;
  sessionId: string;
  workstreamKey?: string | null;
}): Promise<EpisodeSummaryDraft> => {
  const rendered = episodeSummaryPrompt({ transcript: input.transcript });
  const result = await chatCompletion({
    ...rendered,
    telemetry: {
      subsystem: "summary",
      session_id: input.sessionId,
      ...(input.workstreamKey ? { workstream_key: input.workstreamKey } : {}),
      trigger: "episode_summary",
    },
  });
  if (!result) throw new Error("Episode summary LLM returned null");
  return parseEpisodeSummaryDraft(result);
};

const findExistingEpisodeSummary = async (
  episodeId: string,
  scope: WorkspaceScope,
): Promise<{ id: string; payload?: Partial<QdrantPayload> } | null> => {
  const result = await qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/scroll`, {
    filter: buildEpisodeSummaryFilter(episodeId, scope),
    limit: 1,
    with_payload: true,
  }) as { result?: { points?: Array<{ id: string; payload?: Partial<QdrantPayload> }> } };

  return result.result?.points?.[0] ?? null;
};

export const updateEpisodeSummary = async (input: {
  segment: EpisodeSegment;
  sessionId: string;
  scope: WorkspaceScope;
  config: BikkyConfig;
  workstreamRegistry?: WorkstreamRegistry;
}): Promise<EpisodeSummaryWriteResult> => {
  if (!input.segment.transcript.trim()) {
    return { action: "skipped", reason: "empty_transcript", episodeId: input.segment.episode_id };
  }

  const existing = await findExistingEpisodeSummary(input.segment.episode_id, input.scope);
  const draft = await summarizeEpisodeTranscript({
    transcript: input.segment.transcript,
    sessionId: input.sessionId,
    workstreamKey: input.segment.workstream_key ?? null,
  });

  // Resolve workstream key: deterministic extraction wins, then alias lookup,
  // then accept LLM-proposed key as new canonical, otherwise null.
  const resolved: ResolvedWorkstream = resolveWorkstreamKey({
    transcript: input.segment.transcript,
    llmKey: draft.workstream_key ?? input.segment.workstream_key ?? null,
    registry: input.workstreamRegistry,
  });
  const resolvedDraft: EpisodeSummaryDraft = {
    ...draft,
    workstream_key: resolved.key,
    workstream_key_reason: draft.workstream_key_reason ?? resolved.reason,
  };

  const now = new Date().toISOString();
  const { payload } = buildEpisodeSummaryPayload({
    draft: resolvedDraft,
    segment: input.segment,
    sessionId: input.sessionId,
    scope: input.scope,
    now,
    existing,
    redactionOptions: {
      enabled: true,
      redactPii: false,
    },
  });
  const vector = await qdrant.embed(String(payload.content));
  const factId = existing?.id ?? randomUUID();

  await qdrant.qdrantRequest("PUT", `/collections/${qdrant.collection}/points`, {
    points: [{ id: factId, vector, payload }],
  });

  return {
    action: existing ? "updated" : "stored",
    factId,
    episodeId: input.segment.episode_id,
    workstreamKey: resolved.key,
  };
};
