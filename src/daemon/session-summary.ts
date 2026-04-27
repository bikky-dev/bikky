/**
 * Compatibility wrapper for daemon-owned summaries.
 *
 * Sessions are routing/audit boundaries. Durable continuity is captured as
 * episode summaries and workstream summaries; this module keeps the old
 * updateSessionSummary entry point while writing session_index + episode data.
 */
import { createHash } from "node:crypto";

import type { BikkyConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { DEFAULT_CAPTURE_CONTEXT, CAPTURE_POLICY_VERSION, PROMPT_VERSIONS } from "./capture-policy.js";
import { segmentTranscriptIntoEpisodes, updateEpisodeSummary } from "./episode-summary.js";
import { buildSessionIndexFilter, updateSessionIndex } from "./session-index.js";
import { updateWorkstreamSummaries } from "./workstream-summary.js";
import * as qdrant from "./qdrant.js";
import type { QdrantPayload } from "./qdrant.js";
import {
  combineRedactions,
  redactStorageText,
  type RedactionSummary,
} from "../privacy/redaction.js";

export interface WorkspaceScope {
  workspaceId?: string;
  actorId?: string;
  includeLegacy?: boolean;
}

export interface SummaryEvent {
  type: string;
  content?: string;
}

export interface SessionSummaryDraft {
  content: string;
  tasks_completed: string[];
  decisions_made: string[];
  entities: string[];
  importance: number;
}

export interface ExistingSummary {
  id: string;
  payload?: Partial<QdrantPayload>;
}

export interface SessionSummaryPayloadResult {
  payload: Record<string, unknown>;
  redaction: RedactionSummary;
}

export interface SessionSummaryUpdateResult {
  action: "stored" | "updated" | "skipped";
  factId?: string;
  reason?: string;
}

const DEFAULT_SUMMARY_IMPORTANCE = 0.8;

const contentHash = (text: string): string =>
  createHash("sha256").update(`summary:${text}`).digest("hex");

const stripJsonFence = (raw: string): string =>
  raw.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
};

const normalizeEntityArray = (value: unknown): string[] =>
  normalizeStringArray(value).map((entity) => entity.toLowerCase());

const clampImportance = (value: unknown): number => {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_SUMMARY_IMPORTANCE;
  return Math.min(1, Math.max(0.5, value));
};

export const hasCompactionSummary = (events: SummaryEvent[]): boolean =>
  events.some((event) => event.type === "session.compaction_complete" && Boolean(event.content?.trim()));

export const shouldSummarizeEvents = (events: SummaryEvent[], minEvents: number): boolean =>
  events.length >= minEvents || hasCompactionSummary(events);

export const buildSessionSummaryMessages = (input: {
  transcript: string;
  existingSummary?: string | null;
}): Array<{ role: "system" | "user"; content: string }> => [
  {
    role: "system",
    content:
      "You are Bikky's background memory daemon. Maintain a lightweight session index for routing/audit only; do not treat the session as the durable project boundary. " +
      "Preserve task/project context, important files, commands, decisions, failures, fixes, validation results, and open follow-ups. " +
      "Bare status like 'tests passed' is only useful if tied to the branch/task/scope it validates. Output only valid JSON.",
  },
  {
    role: "user",
    content: `Update the existing session index with the new transcript. If there is no existing index, create one.

## Existing summary
${input.existingSummary?.trim() || "(none)"}

## New transcript
${input.transcript}

## Output JSON shape
{
  "content": "2-5 sentence self-contained summary. It must make sense without the surrounding transcript.",
  "tasks_completed": ["short task or milestone labels"],
  "decisions_made": ["decision with rationale if present"],
  "entities": ["lowercase key repos/services/files/tools"],
  "importance": 0.5
}

Return only the JSON object.`,
  },
];

export const parseSessionSummaryDraft = (raw: string): SessionSummaryDraft => {
  const cleaned = stripJsonFence(raw);
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const contentValue = parsed.content ?? parsed.summary;
  if (typeof contentValue !== "string" || !contentValue.trim()) {
    throw new Error("Session summary response missing non-empty content");
  }

  return {
    content: contentValue.trim(),
    tasks_completed: normalizeStringArray(parsed.tasks_completed ?? parsed.tasks),
    decisions_made: normalizeStringArray(parsed.decisions_made ?? parsed.decisions),
    entities: normalizeEntityArray(parsed.entities),
    importance: clampImportance(parsed.importance),
  };
};

export const buildSessionSummaryFilter = (
  sessionId: string,
  scope: WorkspaceScope,
): Record<string, unknown> => {
  return buildSessionIndexFilter(sessionId, scope);
};

export const buildSessionSummaryPayload = (input: {
  draft: SessionSummaryDraft;
  sessionId: string;
  scope: WorkspaceScope;
  now: string;
  existing?: ExistingSummary | null;
  eventCount: number;
  redactionOptions: { enabled: boolean; redactPii: boolean };
}): SessionSummaryPayloadResult => {
  const redactedContent = redactStorageText(input.draft.content, input.redactionOptions);
  const redactedTasks = input.draft.tasks_completed.map((task) => redactStorageText(task, input.redactionOptions));
  const redactedDecisions = input.draft.decisions_made.map((decision) => redactStorageText(decision, input.redactionOptions));
  const redactedEntities = input.draft.entities.map((entity) => redactStorageText(entity, input.redactionOptions));
  const redaction = combineRedactions([
    redactedContent,
    ...redactedTasks,
    ...redactedDecisions,
    ...redactedEntities,
  ]);
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
    prompt_version: PROMPT_VERSIONS.sessionIndex,
    capture_policy_version: CAPTURE_POLICY_VERSION,
    review_status: DEFAULT_CAPTURE_CONTEXT.reviewStatus,
    tasks_completed: redactedTasks.map((task) => task.text),
    decisions_made: redactedDecisions.map((decision) => decision.text),
    metadata: {
      ...(existingPayload.metadata ?? {}),
      summarized_from_session: input.sessionId,
      summary_source: "daemon",
      summary_subtype: "session_index",
      summary_event_count: String(input.eventCount),
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

export const updateSessionSummary = async (input: {
  sessionId: string;
  transcript: string;
  eventCount: number;
  config?: BikkyConfig;
}): Promise<SessionSummaryUpdateResult> => {
  if (!input.transcript.trim()) {
    return { action: "skipped", reason: "empty_transcript" };
  }
  if (!qdrant.isReady()) {
    return { action: "skipped", reason: "qdrant_not_ready" };
  }

  const config = input.config ?? loadConfig();
  const scope: WorkspaceScope = {};
  const segments = segmentTranscriptIntoEpisodes({
    sessionId: input.sessionId,
    transcript: input.transcript,
    eventCount: input.eventCount,
  });
  if (segments.length === 0) {
    return { action: "skipped", reason: "no_episode_segments" };
  }

  const episodeResults = [];
  for (const segment of segments) {
    const result = await updateEpisodeSummary({ segment, sessionId: input.sessionId, scope, config });
    if (result.action === "stored" || result.action === "updated") {
      episodeResults.push(result);
    }
  }

  if (episodeResults.length === 0) {
    return { action: "skipped", reason: "no_episode_summaries" };
  }

  const indexResult = await updateSessionIndex({
    sessionId: input.sessionId,
    eventCount: input.eventCount,
    episodeResults,
    scope,
    config,
  });
  await updateWorkstreamSummaries({ episodeResults, scope, config });

  return {
    action: indexResult.action,
    factId: indexResult.factId,
    reason: indexResult.reason,
  };
};
