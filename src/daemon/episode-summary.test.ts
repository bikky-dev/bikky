import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildEpisodeSummaryFilter,
  buildEpisodeSummaryMessages,
  buildEpisodeSummaryPayload,
  parseEpisodeSummaryDraft,
  segmentTranscriptIntoEpisodes,
} from "./episode-summary.js";

interface WorkspaceScope { workspaceId?: string; actorId?: string; includeLegacy?: boolean }

const defaultScope: WorkspaceScope = {
  workspaceId: "default",
  includeLegacy: true,
};

describe("daemon/episode-summary", () => {
  it("segments two unrelated user tasks in one session into two episodes", () => {
    const transcript = `[USER] Implement ontology v2 in src/mcp/taxonomy.ts and add tests.

[ASSISTANT] Updated src/mcp/taxonomy.ts with software_engineering domains and memory_subtype validation. Ran npm test for taxonomy.

[USER] Now fix the UI smoke tests in packages/ui/tests/smoke.spec.ts.

[ASSISTANT] Updated packages/ui/tests/smoke.spec.ts to cover browse filters and ran npm run test:e2e.`;

    const segments = segmentTranscriptIntoEpisodes({
      sessionId: "uuid:test-session",
      transcript,
      eventCount: 14,
    });

    assert.equal(segments.length, 2);
    assert.match(segments[0].episode_id, /^uuid:test-session:episode:/);
    assert.match(segments[0].transcript, /ontology v2/);
    assert.match(segments[1].transcript, /UI smoke tests/);
  });

  it("does not create episodes for small irrelevant batches", () => {
    const segments = segmentTranscriptIntoEpisodes({
      sessionId: "uuid:test-session",
      transcript: "[USER] ok\n\n[ASSISTANT] done",
      eventCount: 2,
    });
    assert.deepEqual(segments, []);
  });

  it("builds episode summary prompts", () => {
    const messages = buildEpisodeSummaryMessages({
      transcript: "[USER] update src/daemon/extraction.ts",
    });
    assert.match(messages[0].content, /one coherent work episode/);
    assert.match(messages[1].content, /workstream_key/);
  });

  it("parses episode summary drafts", () => {
    const draft = parseEpisodeSummaryDraft(`\`\`\`json
{
  "content": "Implemented ontology v2 extraction for src/daemon/extraction.ts.",
  "tasks_completed": ["ontology extraction"],
  "decisions_made": ["Use memory_subtype on daemon facts"],
  "open_questions": ["wire workstream summaries"],
  "entities": ["Bikky", "src/daemon/extraction.ts"],
  "workstream_key": "243-bikky-data-capture-policy",
  "importance": 0.9
}
\`\`\``);

    assert.equal(draft.content, "Implemented ontology v2 extraction for src/daemon/extraction.ts.");
    assert.deepEqual(draft.entities, ["bikky", "src/daemon/extraction.ts"]);
    assert.equal(draft.workstream_key, "243-bikky-data-capture-policy");
  });

  it("builds episode filters scoped to workspace and subtype", () => {
    const filter = buildEpisodeSummaryFilter("episode-1", defaultScope);
    assert.ok((filter.must as unknown[]).some((condition) =>
      JSON.stringify(condition) === JSON.stringify({ key: "memory_subtype", match: { value: "episode" } }),
    ));
    assert.deepEqual(filter.should, [
      { key: "workspace_id", match: { value: "default" } },
      { is_empty: { key: "workspace_id" } },
    ]);
  });

  it("omits workspace filters when no workspace is supplied", () => {
    const filter = buildEpisodeSummaryFilter("episode-1", {});
    assert.equal(filter.should, undefined);
    assert.equal((filter.must as unknown[]).some((condition) =>
      JSON.stringify(condition).includes("workspace_id"),
    ), false);
  });

  it("builds ontology-v2 episode payloads", () => {
    const { payload } = buildEpisodeSummaryPayload({
      draft: {
        content: "Implemented daemon episode summaries for src/daemon/episode-summary.ts.",
        tasks_completed: ["episode summaries"],
        decisions_made: ["Use episode summaries instead of one evolving session summary"],
        open_questions: ["workstream updater"],
        entities: ["bikky", "src/daemon/episode-summary.ts"],
        workstream_key: "243-bikky-data-capture-policy",
        importance: 0.85,
      },
      segment: {
        episode_id: "episode-1",
        ordinal: 0,
        transcript: "[USER] implement episodes",
        event_count: 8,
      },
      sessionId: "uuid:test-session",
      scope: { workspaceId: "team-a", actorId: "agent-1", includeLegacy: false },
      now: "2026-04-25T12:00:00.000Z",
      redactionOptions: { enabled: true, redactPii: true },
    });

    assert.equal(payload.kind, "summary");
    assert.equal(payload.memory_subtype, "episode");
    assert.equal(payload.domain, "software_engineering");
    assert.equal(payload.episode_id, "episode-1");
    assert.equal(payload.workstream_key, "243-bikky-data-capture-policy");
    assert.equal((payload.metadata as Record<string, string>).summary_subtype, "episode");
  });
});
