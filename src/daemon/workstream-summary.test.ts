import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkstreamEpisodeFilter,
  buildWorkstreamSummaryFilter,
  buildWorkstreamSummaryMessages,
  buildWorkstreamSummaryPayload,
  groupEpisodeResultsByWorkstream,
  parseWorkstreamSummaryDraft,
} from "./workstream-summary.js";

interface WorkspaceScope { workspaceId?: string; actorId?: string; includeLegacy?: boolean }

const defaultScope: WorkspaceScope = {
  workspaceId: "default",
  includeLegacy: true,
};

describe("daemon/workstream-summary", () => {
  it("groups only explicit workstream keys and leaves ambiguous episodes unassigned", () => {
    const grouped = groupEpisodeResultsByWorkstream([
      { action: "stored", factId: "fact-1", episodeId: "episode-1", workstreamKey: "task-a" },
      { action: "stored", factId: "fact-2", episodeId: "episode-2", workstreamKey: null },
      { action: "updated", factId: "fact-3", episodeId: "episode-3", workstreamKey: "task-a" },
      { action: "stored", factId: "fact-4", episodeId: "episode-4", workstreamKey: "task-b" },
    ]);

    assert.equal(grouped.size, 2);
    assert.equal(grouped.get("task-a")?.length, 2);
    assert.equal(grouped.get("task-b")?.length, 1);
    assert.equal(grouped.has(""), false);
  });

  it("prompts for current-state workstream summaries instead of diary chronology", () => {
    const messages = buildWorkstreamSummaryMessages({
      workstreamKey: "task-a",
      existingSummary: "Old state",
      episodeSummaries: ["Implemented the memory ontology.", "Added tests."],
    });

    assert.match(messages[0].content, /current-state workstream summary/);
    assert.match(messages[0].content, /Do not append a diary/);
    assert.match(messages[1].content, /task-a/);
  });

  it("parses workstream summary drafts", () => {
    const draft = parseWorkstreamSummaryDraft(`\`\`\`json
{
  "content": "The memory ontology is implemented and extraction is being hardened.",
  "current_decisions": ["Use domain for activity profile"],
  "next_steps": ["Run full validation"],
  "blockers": ["None"],
  "entities": ["Bikky", "Qdrant"],
  "importance": 0.9
}
\`\`\``);

    assert.equal(draft.content, "The memory ontology is implemented and extraction is being hardened.");
    assert.deepEqual(draft.current_decisions, ["Use domain for activity profile"]);
    assert.deepEqual(draft.entities, ["bikky", "qdrant"]);
  });

  it("builds filters scoped to workstream subtype", () => {
    const summaryFilter = buildWorkstreamSummaryFilter("task-a", defaultScope);
    assert.ok((summaryFilter.must as unknown[]).some((condition) =>
      JSON.stringify(condition) === JSON.stringify({ key: "memory_subtype", match: { value: "workstream" } }),
    ));

    const episodeFilter = buildWorkstreamEpisodeFilter("task-a", defaultScope);
    assert.ok((episodeFilter.must as unknown[]).some((condition) =>
      JSON.stringify(condition) === JSON.stringify({ key: "memory_subtype", match: { value: "episode" } }),
    ));
  });

  it("omits workspace filters when no workspace is supplied", () => {
    const summaryFilter = buildWorkstreamSummaryFilter("task-a", {});
    const episodeFilter = buildWorkstreamEpisodeFilter("task-a", {});
    assert.equal(summaryFilter.should, undefined);
    assert.equal(episodeFilter.should, undefined);
    assert.equal((summaryFilter.must as unknown[]).some((condition) =>
      JSON.stringify(condition).includes("workspace_id"),
    ), false);
    assert.equal((episodeFilter.must as unknown[]).some((condition) =>
      JSON.stringify(condition).includes("workspace_id"),
    ), false);
  });

  it("builds one current-state payload per workstream", () => {
    const { payload } = buildWorkstreamSummaryPayload({
      draft: {
        content: "Memory ontology implementation is in validation.",
        current_decisions: ["Use software_engineering as the default domain"],
        next_steps: ["Run npm test"],
        blockers: [],
        entities: ["bikky"],
        importance: 0.85,
      },
      workstreamKey: "243-bikky-data-capture-policy",
      scope: { workspaceId: "team-a", actorId: "agent-1", includeLegacy: false },
      now: "2026-04-25T12:00:00.000Z",
      sourceEpisodeIds: ["episode-1", "episode-2"],
      repo: "bikky-dev/bikky",
      redactionOptions: { enabled: true, redactPii: true },
    });

    assert.equal(payload.kind, "summary");
    assert.equal(payload.memory_subtype, "workstream");
    assert.equal(payload.layer, "workstream");
    assert.equal(payload.workstream_key, "243-bikky-data-capture-policy");
    assert.equal(payload.repo, "bikky-dev/bikky");
    assert.deepEqual(payload.source_episode_ids, ["episode-1", "episode-2"]);
    assert.equal((payload.metadata as Record<string, string>).summary_subtype, "workstream");
  });
});
