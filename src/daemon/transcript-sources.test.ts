import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONFIG_DEFAULTS, type BikkyConfig } from "../config.js";
import {
  discoverClaudeTranscriptMappings,
  discoverCopilotTranscriptMappings,
  extractionStateKey,
  parseClaudeTranscriptLine,
  parseCopilotTranscriptLine,
  readNewTranscriptEvents,
} from "./transcript-sources.js";

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-transcript-sources-"));

const testConfig = (watchers: Partial<BikkyConfig["watchers"]>): BikkyConfig => ({
  ...CONFIG_DEFAULTS,
  watchers: {
    ...CONFIG_DEFAULTS.watchers,
    ...watchers,
  },
});

beforeEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });
});

after(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe("transcript source discovery", () => {
  it("discovers live Copilot sessions with events.jsonl", async () => {
    const sessionDir = path.join(testDir, "copilot-session");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), "");
    fs.writeFileSync(path.join(sessionDir, "inuse.123.lock"), "");
    fs.writeFileSync(path.join(sessionDir, "inuse.456.lock"), "");

    const mappings = await discoverCopilotTranscriptMappings(
      testConfig({ copilot: { enabled: true, path: testDir } }),
      (pid) => pid === 123,
    );

    assert.strictEqual(mappings.length, 1);
    assert.deepStrictEqual(mappings[0], {
      source: "copilot",
      pid: 123,
      uuid: "copilot-session",
      eventsPath: path.join(sessionDir, "events.jsonl"),
      active: true,
    });
  });

  it("discovers Claude project transcripts and skips nested artifacts", async () => {
    const projectDir = path.join(testDir, "-Users-test-code-project");
    const nestedDir = path.join(projectDir, "subagents");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "claude-session.jsonl"), "");
    fs.writeFileSync(path.join(nestedDir, "nested-session.jsonl"), "");

    const mappings = await discoverClaudeTranscriptMappings(
      testConfig({ claude: { enabled: true, path: testDir } }),
    );

    assert.strictEqual(mappings.length, 1);
    assert.strictEqual(mappings[0].source, "claude");
    assert.strictEqual(mappings[0].uuid, "claude-session");
    assert.strictEqual(mappings[0].eventsPath, path.join(projectDir, "claude-session.jsonl"));
    assert.strictEqual(extractionStateKey(mappings[0]), "claude:claude-session");
  });

  it("returns no Claude transcripts when the watcher is disabled", async () => {
    fs.writeFileSync(path.join(testDir, "claude-session.jsonl"), "");

    const mappings = await discoverClaudeTranscriptMappings(
      testConfig({ claude: { enabled: false, path: testDir } }),
    );

    assert.deepStrictEqual(mappings, []);
  });

  it("returns no transcripts for missing watcher directories", async () => {
    const missingDir = path.join(testDir, "missing");

    assert.deepStrictEqual(
      await discoverCopilotTranscriptMappings(
        testConfig({ copilot: { enabled: true, path: missingDir } }),
        () => true,
      ),
      [],
    );
    assert.deepStrictEqual(
      await discoverClaudeTranscriptMappings(
        testConfig({ claude: { enabled: true, path: missingDir } }),
      ),
      [],
    );
  });
});

describe("transcript source parsing", () => {
  it("parses Copilot user, assistant, and summary events", () => {
    assert.deepStrictEqual(
      parseCopilotTranscriptLine(JSON.stringify({
        type: "assistant.message",
        timestamp: "2026-05-04T00:00:00.000Z",
        data: { content: "Done.", reasoningText: "Reasoned summary." },
      })),
      {
        type: "assistant.message",
        content: "Done.\nReasoned summary.",
        timestamp: "2026-05-04T00:00:00.000Z",
      },
    );

    assert.deepStrictEqual(
      parseCopilotTranscriptLine(JSON.stringify({
        type: "session.compaction_complete",
        data: { summaryContent: "Prior session summary." },
      }))?.content,
      "Prior session summary.",
    );
  });

  it("parses Claude text and skips tool/thinking blocks", () => {
    const event = parseClaudeTranscriptLine(JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-04T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "Visible answer." },
          { type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } },
        ],
      },
    }));

    assert.deepStrictEqual(event, {
      type: "assistant.message",
      content: "Visible answer.",
      timestamp: "2026-05-04T00:00:00.000Z",
    });
  });

  it("parses Claude user string content and ignores non-conversation records", () => {
    assert.deepStrictEqual(
      parseClaudeTranscriptLine(JSON.stringify({
        type: "user",
        message: { role: "user", content: "Please remember this preference." },
      }))?.content,
      "Please remember this preference.",
    );

    assert.strictEqual(
      parseClaudeTranscriptLine(JSON.stringify({
        type: "system",
        content: "startup metadata",
      })),
      null,
    );
  });

  it("reads new transcript events from a byte offset", async () => {
    const firstLine = `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "First message." },
    })}\n`;
    const secondLine = `${JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Second message." }] },
    })}\n`;
    const transcriptPath = path.join(testDir, "offset-session.jsonl");
    fs.writeFileSync(transcriptPath, firstLine + secondLine);

    const result = await readNewTranscriptEvents(transcriptPath, Buffer.byteLength(firstLine), "claude");

    assert.strictEqual(result.events.length, 1);
    assert.strictEqual(result.events[0].content, "Second message.");
    assert.strictEqual(result.totalLines, 1);
  });

  it("recovers from transcript truncation when byte offset is beyond EOF", async () => {
    const line = `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "Rotated transcript starts over." },
    })}\n`;
    const transcriptPath = path.join(testDir, "rotated-session.jsonl");
    fs.writeFileSync(transcriptPath, line);

    const result = await readNewTranscriptEvents(transcriptPath, 10_000, "claude");

    assert.strictEqual(result.events.length, 1);
    assert.strictEqual(result.events[0].content, "Rotated transcript starts over.");
    assert.strictEqual(result.totalLines, 1);
    assert.strictEqual(result.newOffset, Buffer.byteLength(line));
  });

  it("advances past malformed transcript lines without poisoning later reads", async () => {
    const goodLine = `${JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Valid response." }] },
    })}\n`;
    const content = `not-json\n${goodLine}`;
    const transcriptPath = path.join(testDir, "malformed-session.jsonl");
    fs.writeFileSync(transcriptPath, content);

    const result = await readNewTranscriptEvents(transcriptPath, 0, "claude");

    assert.strictEqual(result.events.length, 1);
    assert.strictEqual(result.events[0].content, "Valid response.");
    assert.strictEqual(result.totalLines, 2);
    assert.strictEqual(result.newOffset, Buffer.byteLength(content));
  });
});
