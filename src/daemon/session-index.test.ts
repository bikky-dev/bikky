import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionIndexDraft,
  buildSessionIndexFilter,
  buildSessionIndexPayload,
} from "./session-index.js";

interface WorkspaceScope { workspaceId?: string; actorId?: string; includeLegacy?: boolean }

const defaultScope: WorkspaceScope = {
  workspaceId: "default",
  includeLegacy: true,
};

describe("daemon/session-index", () => {
  it("builds one low-priority index from multiple episode results", () => {
    const draft = buildSessionIndexDraft({
      sessionId: "uuid:test-session",
      eventCount: 20,
      episodeResults: [
        { action: "stored", factId: "fact-1", episodeId: "episode-1", workstreamKey: "task-a" },
        { action: "stored", factId: "fact-2", episodeId: "episode-2", workstreamKey: "task-b" },
      ],
    });

    assert.deepEqual(draft.episode_ids, ["episode-1", "episode-2"]);
    assert.deepEqual(draft.workstream_keys, ["task-a", "task-b"]);
    assert.equal(draft.importance, 0.35);
  });

  it("filters by session_index subtype", () => {
    const filter = buildSessionIndexFilter("uuid:test-session", defaultScope);
    assert.ok((filter.must as unknown[]).some((condition) =>
      JSON.stringify(condition) === JSON.stringify({ key: "memory_subtype", match: { value: "session_index" } }),
    ));
  });

  it("omits workspace filters when no workspace is supplied", () => {
    const filter = buildSessionIndexFilter("uuid:test-session", {});
    assert.equal(filter.should, undefined);
    assert.equal((filter.must as unknown[]).some((condition) =>
      JSON.stringify(condition).includes("workspace_id"),
    ), false);
  });

  it("builds memory ontology session index payloads", () => {
    const draft = {
      ...buildSessionIndexDraft({
        sessionId: "uuid:test-session",
        eventCount: 12,
        episodeResults: [
          { action: "stored", factId: "fact-1", episodeId: "episode-1", workstreamKey: "task-a" },
        ],
      }),
      content: "Session captured one episode with password=supersecretvalue.",
    };
    const { payload, redaction } = buildSessionIndexPayload({
      draft,
      sessionId: "uuid:test-session",
      scope: { workspaceId: "team-a", actorId: "agent-1", includeLegacy: false },
      now: "2026-04-25T12:00:00.000Z",
      eventCount: 12,
      redactionOptions: { enabled: true, redactPii: true },
    });

    assert.equal(payload.kind, "summary");
    assert.equal(payload.memory_subtype, "session_index");
    assert.equal(payload.domain, "software_engineering");
    assert.equal(payload.content, "Session captured one episode with password=[REDACTED:secret]");
    assert.deepEqual(payload.source_episode_ids, ["episode-1"]);
    assert.equal((payload.metadata as Record<string, string>).workstream_keys, "task-a");
    assert.equal(redaction.redacted, true);
    assert.deepEqual(payload.redaction, redaction);
  });
});
