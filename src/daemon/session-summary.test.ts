import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionSummaryFilter,
  buildSessionSummaryMessages,
  buildSessionSummaryPayload,
  hasCompactionSummary,
  parseSessionSummaryDraft,
  shouldSummarizeEvents,
} from "./session-summary.js";

interface WorkspaceScope { workspaceId?: string; actorId?: string; includeLegacy?: boolean }

const defaultScope: WorkspaceScope = {
  workspaceId: "default",
  includeLegacy: true,
};

describe("daemon/session-summary", () => {
  describe("shouldSummarizeEvents", () => {
    it("summarizes when the normal extraction threshold is met", () => {
      const events = Array.from({ length: 5 }, (_, index) => ({
        type: "assistant.message",
        content: `event ${index}`,
      }));
      assert.equal(shouldSummarizeEvents(events, 5), true);
    });

    it("summarizes compaction summaries even below the extraction threshold", () => {
      const events = [{ type: "session.compaction_complete", content: "Session summary content" }];
      assert.equal(hasCompactionSummary(events), true);
      assert.equal(shouldSummarizeEvents(events, 5), true);
    });

    it("skips small non-compaction batches", () => {
      const events = [{ type: "assistant.message", content: "short update" }];
      assert.equal(shouldSummarizeEvents(events, 5), false);
    });
  });

  describe("buildSessionSummaryMessages", () => {
    it("instructs the daemon to produce self-contained lifecycle summaries", () => {
      const messages = buildSessionSummaryMessages({
        existingSummary: "Existing context",
        transcript: "[USER] add daemon summaries",
      });

      assert.equal(messages[0].role, "system");
      assert.match(messages[0].content, /background memory daemon/);
      assert.match(messages[0].content, /routing\/audit/);
      assert.match(messages[0].content, /Bare status like 'tests passed'/);
      assert.match(messages[1].content, /Existing context/);
      assert.match(messages[1].content, /self-contained summary/);
    });
  });

  describe("parseSessionSummaryDraft", () => {
    it("parses fenced JSON and normalizes arrays", () => {
      const draft = parseSessionSummaryDraft(`\`\`\`json
{
  "summary": "Implemented daemon-owned summaries for issue #14.",
  "tasks": ["issue-14", "issue-14", "daemon summaries"],
  "decisions": ["Daemon owns lifecycle memory"],
  "entities": ["Bikky", "src/daemon/session-summary.ts"],
  "importance": 0.95
}
\`\`\``);

      assert.equal(draft.content, "Implemented daemon-owned summaries for issue #14.");
      assert.deepEqual(draft.tasks_completed, ["issue-14", "daemon summaries"]);
      assert.deepEqual(draft.decisions_made, ["Daemon owns lifecycle memory"]);
      assert.deepEqual(draft.entities, ["bikky", "src/daemon/session-summary.ts"]);
      assert.equal(draft.importance, 0.95);
    });

    it("rejects empty summaries", () => {
      assert.throws(
        () => parseSessionSummaryDraft(JSON.stringify({ content: "   " })),
        /missing non-empty content/,
      );
    });
  });

  describe("buildSessionSummaryFilter", () => {
    it("includes legacy summaries for default workspace scopes", () => {
      const filter = buildSessionSummaryFilter("uuid:test-session", defaultScope);
      const should = filter.should as unknown[];

      assert.deepEqual((filter.must as unknown[]).slice(0, 3), [
        { key: "session_id", match: { value: "uuid:test-session" } },
        { key: "kind", match: { value: "summary" } },
        { key: "memory_subtype", match: { value: "session_index" } },
      ]);
      assert.deepEqual((filter.must as unknown[]).slice(3, 4), [
        { is_null: { key: "superseded_by" } },
      ]);
      assert.deepEqual(should, [
        { key: "workspace_id", match: { value: "default" } },
        { is_empty: { key: "workspace_id" } },
      ]);
    });

    it("requires workspace match when legacy inclusion is disabled", () => {
      const filter = buildSessionSummaryFilter("uuid:test-session", {
        workspaceId: "team-a",
        actorId: "agent-1",
        includeLegacy: false,
      });

      assert.equal(filter.should, undefined);
      assert.ok((filter.must as unknown[]).some((condition) =>
        JSON.stringify(condition) === JSON.stringify({ key: "workspace_id", match: { value: "team-a" } }),
      ));
    });
  });

  describe("buildSessionSummaryPayload", () => {
    it("redacts secrets in system summary payloads with optional workspace metadata", () => {
      const { payload, redaction } = buildSessionSummaryPayload({
        draft: {
          content: "Configured service with password=supersecretvalue during daemon summary work.",
          tasks_completed: ["issue #14"],
          decisions_made: ["Daemon owns summaries"],
          entities: ["bikky", "daemon"],
          importance: 0.9,
        },
        sessionId: "uuid:test-session",
        scope: { workspaceId: "team-a", actorId: "agent-1", includeLegacy: false },
        now: "2026-04-25T11:00:00.000Z",
        eventCount: 7,
        redactionOptions: { enabled: true, redactPii: true },
      });

      assert.equal(payload.category, "projects");
      assert.equal(payload.domain, "software_engineering");
      assert.equal(payload.kind, "summary");
      assert.equal(payload.memory_subtype, "session_index");
      assert.equal(payload.source, "system");
      assert.equal(payload.workspace_id, "team-a");
      assert.equal(payload.actor_id, "agent-1");
      assert.equal(payload.session_id, "uuid:test-session");
      assert.equal(payload.content, "Configured service with password=[REDACTED:secret] during daemon summary work.");
      assert.deepEqual(payload.tasks_completed, ["issue #14"]);
      assert.deepEqual(payload.decisions_made, ["Daemon owns summaries"]);
      assert.deepEqual(payload.entities, ["bikky", "daemon"]);
      assert.equal((payload.metadata as Record<string, string>).summary_source, "daemon");
      assert.equal((payload.metadata as Record<string, string>).summary_subtype, "session_index");
      assert.equal((payload.metadata as Record<string, string>).summary_event_count, "7");
      assert.equal(redaction.redacted, true);
      assert.deepEqual(redaction.matches, [{ type: "secret", count: 1 }]);
      assert.deepEqual(payload.redaction, redaction);
    });

    it("preserves existing created_at and fact counters on update", () => {
      const { payload } = buildSessionSummaryPayload({
        draft: {
          content: "Updated summary",
          tasks_completed: [],
          decisions_made: [],
          entities: [],
          importance: 0.8,
        },
        sessionId: "uuid:test-session",
        scope: defaultScope,
        now: "2026-04-25T11:00:00.000Z",
        existing: {
          id: "existing-id",
          payload: {
            content: "Old summary",
            category: "projects",
            entities: [],
            confidence: 1,
            content_hash: "old",
            reinforcement_count: 3,
            last_reinforced_at: "2026-04-25T10:00:00.000Z",
            superseded_by: null,
            superseded_at: null,
            created_at: "2026-04-25T10:00:00.000Z",
            updated_at: "2026-04-25T10:00:00.000Z",
          },
        },
        eventCount: 3,
        redactionOptions: { enabled: true, redactPii: true },
      });

      assert.equal(payload.created_at, "2026-04-25T10:00:00.000Z");
      assert.equal(payload.updated_at, "2026-04-25T11:00:00.000Z");
      assert.equal(payload.reinforcement_count, 3);
      assert.equal(payload.last_reinforced_at, "2026-04-25T10:00:00.000Z");
    });
  });
});
