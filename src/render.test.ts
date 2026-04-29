/**
 * Tests for the `bikky render` CLI plumbing.
 *
 * We test the pure pieces (parseRenderArgs, renderPrompt, listPrompts) directly.
 * The full runRenderCli is tested via stdout capture.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_REGISTRY,
  listPrompts,
  parseRenderArgs,
  renderPrompt,
  runRenderCli,
} from "./render.js";

// ── parseRenderArgs ─────────────────────────────────────────────────────────

test("parseRenderArgs: bare name", () => {
  const args = parseRenderArgs(["extraction"]);
  assert.equal(args.name, "extraction");
  assert.equal(args.inputPath, null);
  assert.equal(args.list, false);
});

test("parseRenderArgs: --input <path>", () => {
  const args = parseRenderArgs(["extraction", "--input", "case.json"]);
  assert.equal(args.name, "extraction");
  assert.equal(args.inputPath, "case.json");
});

test("parseRenderArgs: --input=path", () => {
  const args = parseRenderArgs(["extraction", "--input=case.json"]);
  assert.equal(args.inputPath, "case.json");
});

test("parseRenderArgs: --list", () => {
  const args = parseRenderArgs(["--list"]);
  assert.equal(args.list, true);
  assert.equal(args.name, null);
});

test("parseRenderArgs: --help", () => {
  const args = parseRenderArgs(["--help"]);
  assert.equal(args.help, true);
});

test("parseRenderArgs: rejects unknown flag", () => {
  assert.throws(() => parseRenderArgs(["--nope"]), /Unknown flag/);
});

test("parseRenderArgs: rejects extra positional", () => {
  assert.throws(() => parseRenderArgs(["a", "b"]), /Unexpected positional/);
});

test("parseRenderArgs: --input requires a value", () => {
  assert.throws(() => parseRenderArgs(["x", "--input"]), /requires a path/);
});

// ── listPrompts ─────────────────────────────────────────────────────────────

test("listPrompts returns all prompts", () => {
  const list = listPrompts();
  const names = list.map((p) => p.name).sort();
  assert.deepEqual(names, [
    "brief",
    "contradiction",
    "distill",
    "entity-typing",
    "episode-summary",
    "extraction",
    "relations",
    "workstream-summary",
  ]);
  for (const p of list) {
    assert.ok(p.id, `${p.name} has no id`);
    assert.ok(p.version, `${p.name} has no version`);
    assert.ok(p.describe, `${p.name} has no description`);
  }
});

test("PROMPT_REGISTRY ids match descriptors", () => {
  // Stable ids; if a prompt rename happens, both this test and the registry must update.
  assert.equal(PROMPT_REGISTRY.extraction.id, "extraction");
  assert.equal(PROMPT_REGISTRY.distill.id, "distill");
  assert.equal(PROMPT_REGISTRY.contradiction.id, "contradiction");
  assert.equal(PROMPT_REGISTRY.relations.id, "relations");
  assert.equal(PROMPT_REGISTRY.brief.id, "brief");
  assert.equal(PROMPT_REGISTRY["episode-summary"].id, "episode-summary");
  assert.equal(PROMPT_REGISTRY["workstream-summary"].id, "workstream-summary");
});

// ── renderPrompt ────────────────────────────────────────────────────────────

test("renderPrompt: extraction renders with system+user messages", () => {
  const out = renderPrompt("extraction", { transcript: "hello world" });
  assert.match(out.promptName, /^extraction@/);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].role, "user");
  assert.ok(out.messages[1].content.includes("hello world"), "user message must include input");
  assert.ok(typeof out.temperature === "number");
});

test("renderPrompt: distill renders with summaries", () => {
  const out = renderPrompt("distill", {
    summaries: [
      { id: 1, date: "2026-04-01", content: "first session", tasks_completed: ["a"], decisions_made: [] },
      { id: 2, date: "2026-04-02", content: "second session", tasks_completed: [], decisions_made: ["b"] },
      { id: 3, date: "2026-04-03", content: "third session", tasks_completed: [], decisions_made: [] },
    ],
  });
  assert.match(out.promptName, /^distill@/);
  assert.ok(out.messages[1].content.includes("first session"));
  assert.ok(out.messages[1].content.includes("third session"));
});

test("renderPrompt: contradiction renders", () => {
  const out = renderPrompt("contradiction", {
    newFact: { content: "user lives in Berlin", category: "human" },
    candidates: [{ id: "f1", content: "user lives in Paris", category: "human", score: 0.91 }],
  });
  assert.match(out.promptName, /^contradiction@/);
  assert.ok(out.messages[1].content.includes("Berlin"));
  assert.ok(out.messages[1].content.includes("Paris"));
});

test("renderPrompt: relations renders", () => {
  const out = renderPrompt("relations", {
    entityA: "alice",
    entityB: "platform",
    sharedFacts: [{ content: "alice deployed platform v2", category: "system" }],
  });
  assert.match(out.promptName, /^relations@/);
  assert.ok(out.messages[1].content.includes("alice"));
  assert.ok(out.messages[1].content.includes("platform"));
});

test("renderPrompt: brief renders", () => {
  const out = renderPrompt("brief", {
    generatedAt: "2026-04-25",
    sections: { System: ["thread one", "thread two"] },
  });
  assert.match(out.promptName, /^brief@/);
  assert.ok(out.messages[1].content.includes("thread one"));
});

test("renderPrompt: episode-summary renders", () => {
  const out = renderPrompt("episode-summary", {
    transcript: "[USER] Implement episode summaries in src/daemon/episode-summary.ts.",
  });
  assert.match(out.promptName, /^episode-summary@/);
  assert.ok(out.messages[1].content.includes("src/daemon/episode-summary.ts"));
  assert.deepEqual(out.response_format, { type: "json_object" });
});

test("renderPrompt: workstream-summary renders", () => {
  const out = renderPrompt("workstream-summary", {
    workstreamKey: "231-bikky-evals-deepeval",
    existingSummary: "Eval harness has memory ontology coverage.",
    episodeSummaries: ["Added episode-summary eval cases.", "Added workstream-summary eval cases."],
  });
  assert.match(out.promptName, /^workstream-summary@/);
  assert.ok(out.messages[1].content.includes("231-bikky-evals-deepeval"));
  assert.ok(out.messages[1].content.includes("episode-summary eval cases"));
  assert.deepEqual(out.response_format, { type: "json_object" });
});

test("renderPrompt: unknown name throws with helpful message", () => {
  assert.throws(
    () => renderPrompt("nope", {}),
    /Unknown prompt: "nope".*Available:/s,
  );
});

// ── runRenderCli (full integration via stdout capture) ──────────────────────

function captureStdout<T>(fn: () => T | Promise<T>): { code: T; stdout: string; stderr: string } | Promise<{ code: T; stdout: string; stderr: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let stdout = "";
  let stderr = "";
  console.log = (...args: unknown[]) => { stdout += args.join(" ") + "\n"; };
  console.error = (...args: unknown[]) => { stderr += args.join(" ") + "\n"; };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then((code) => {
        console.log = origLog;
        console.error = origErr;
        return { code, stdout, stderr };
      }).catch((err) => {
        console.log = origLog;
        console.error = origErr;
        throw err;
      });
    }
    console.log = origLog;
    console.error = origErr;
    return { code: result, stdout, stderr };
  } catch (err) {
    console.log = origLog;
    console.error = origErr;
    throw err;
  }
}

test("runRenderCli: --list prints JSON list of prompts", async () => {
  const result = await captureStdout(() => runRenderCli(["--list"]));
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout) as Array<{ name: string }>;
  assert.equal(parsed.length, 8);
  assert.ok(parsed.find((p) => p.name === "extraction"));
  assert.ok(parsed.find((p) => p.name === "episode-summary"));
  assert.ok(parsed.find((p) => p.name === "workstream-summary"));
});

test("runRenderCli: --help exits 0", async () => {
  const result = await captureStdout(() => runRenderCli(["--help"]));
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes("Usage:"));
});

test("runRenderCli: missing name returns 1", async () => {
  const result = await captureStdout(() => runRenderCli([]));
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("prompt name is required"));
});

test("runRenderCli: unknown prompt returns 1 with available list", async () => {
  // Fake stdin via --input pointing at /dev/null trick — instead use a temp file
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = path.join(os.tmpdir(), `bikky-render-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, "{}");
  try {
    const result = await captureStdout(() => runRenderCli(["nope", "--input", tmp]));
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("Unknown prompt"));
    assert.ok(result.stderr.includes("extraction"), "should list available prompts");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("runRenderCli: malformed input JSON returns 1", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = path.join(os.tmpdir(), `bikky-render-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, "not json {");
  try {
    const result = await captureStdout(() => runRenderCli(["extraction", "--input", tmp]));
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("parsing input JSON"));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("runRenderCli: full render via --input file produces valid JSON", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const tmp = path.join(os.tmpdir(), `bikky-render-test-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ transcript: "test transcript" }));
  try {
    const result = await captureStdout(() => runRenderCli(["extraction", "--input", tmp]));
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as { promptName: string; messages: unknown[] };
    assert.match(parsed.promptName, /^extraction@/);
    assert.equal(parsed.messages.length, 2);
  } finally {
    fs.unlinkSync(tmp);
  }
});
