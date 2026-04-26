/**
 * Prompt builder tests — assert structure, anti-injection wrapping,
 * version stamping, and required output-format directives. These are
 * effectively snapshot-style tests but written as explicit invariants
 * so a regression is obvious in code review.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractionPrompt,
  EXTRACTION_PROMPT_DESCRIPTOR,
  distillPrompt,
  DISTILL_PROMPT_DESCRIPTOR,
  contradictionPrompt,
  CONTRADICTION_PROMPT_DESCRIPTOR,
  relationsPrompt,
  RELATIONS_PROMPT_DESCRIPTOR,
  briefPrompt,
  BRIEF_PROMPT_DESCRIPTOR,
  ALLOWED_BRIEF_HEADINGS,
  wrapData,
  safeParseJson,
} from "./index.js";

const messages = (rendered: { messages: { role: string; content: string }[] }) =>
  rendered.messages.map((m) => `${m.role}:${m.content}`).join("\n---\n");

describe("prompt registry — invariants", () => {
  it("every descriptor has id and date-stamped version", () => {
    const descriptors = [
      EXTRACTION_PROMPT_DESCRIPTOR,
      DISTILL_PROMPT_DESCRIPTOR,
      CONTRADICTION_PROMPT_DESCRIPTOR,
      RELATIONS_PROMPT_DESCRIPTOR,
      BRIEF_PROMPT_DESCRIPTOR,
    ];
    for (const d of descriptors) {
      assert.ok(d.id.length > 0, `${d.id}: empty id`);
      assert.match(d.version, /^\d{4}-\d{2}-\d{2}-\d+$/, `${d.id}: bad version ${d.version}`);
    }
  });

  it("wrapData emits opening + closing tags around content", () => {
    const out = wrapData("transcript", "hello\nworld");
    assert.ok(out.startsWith("<transcript>"));
    assert.ok(out.endsWith("</transcript>"));
    assert.ok(out.includes("hello\nworld"));
  });

  it("safeParseJson strips ```json fences", () => {
    const parsed = safeParseJson<{ ok: boolean }>("```json\n{\"ok\": true}\n```");
    assert.deepEqual(parsed, { ok: true });
  });

  it("safeParseJson tolerates leading prose", () => {
    const parsed = safeParseJson<{ a: number }>("Sure, here you go: {\"a\": 1} -- done");
    assert.deepEqual(parsed, { a: 1 });
  });

  it("safeParseJson returns null on garbage", () => {
    assert.equal(safeParseJson("not json at all"), null);
  });
});

describe("extractionPrompt", () => {
  const rendered = extractionPrompt({ transcript: "user: hi\nassistant: bye" });

  it("stamps id@version into promptName", () => {
    assert.equal(
      rendered.promptName,
      `${EXTRACTION_PROMPT_DESCRIPTOR.id}@${EXTRACTION_PROMPT_DESCRIPTOR.version}`,
    );
  });

  it("requests JSON object output", () => {
    assert.equal(rendered.response_format?.type, "json_object");
  });

  it("wraps the transcript in <transcript> tags (anti-injection)", () => {
    const text = messages(rendered);
    assert.ok(text.includes("<transcript>"));
    assert.ok(text.includes("</transcript>"));
    assert.ok(text.includes("user: hi"));
  });

  it("emits the schema fields the daemon expects", () => {
    const text = messages(rendered);
    for (const field of ["content", "category", "domain", "kind", "memory_subtype", "entities", "confidence", "importance"]) {
      assert.ok(text.includes(field), `extraction prompt missing field hint: ${field}`);
    }
  });
});

describe("distillPrompt", () => {
  const rendered = distillPrompt({
    summaries: [
      { id: 1, date: "2026-04-20", content: "Worked on auth" },
      { id: 2, date: "2026-04-21", content: "Finished retry logic" },
    ],
  });

  it("requests JSON output", () => {
    assert.equal(rendered.response_format?.type, "json_object");
  });

  it("wraps each summary with its id and date", () => {
    const text = messages(rendered);
    assert.ok(text.includes('id="1"') || text.includes("id=\"1\""));
    assert.ok(text.includes("2026-04-20"));
    assert.ok(text.includes("Worked on auth"));
  });

  it("requires evidence_summary_ids in the schema", () => {
    const text = messages(rendered);
    assert.ok(text.includes("evidence_summary_ids"));
  });
});

describe("contradictionPrompt", () => {
  const rendered = contradictionPrompt({
    newFact: { content: "Server runs on port 9090", category: "infrastructure" },
    candidates: [
      { id: "c1", content: "Server runs on port 8080", category: "infrastructure", score: 0.91 },
    ],
  });

  it("offers all three outcomes", () => {
    const text = messages(rendered);
    for (const outcome of ["compatible", "superseded", "contradicted"]) {
      assert.ok(text.includes(outcome), `contradiction prompt missing outcome: ${outcome}`);
    }
  });

  it("wraps both facts as data", () => {
    const text = messages(rendered);
    assert.ok(text.includes("9090"));
    assert.ok(text.includes("8080"));
  });
});

describe("relationsPrompt", () => {
  const rendered = relationsPrompt({
    entityA: "platform",
    entityB: "qdrant",
    sharedFacts: [
      { content: "platform uses qdrant for vector storage", category: "infrastructure" },
    ],
  });

  it("requires verbatim evidence quote", () => {
    const text = messages(rendered);
    assert.ok(/evidence/i.test(text));
    assert.ok(/quote|verbatim|exact/i.test(text));
  });

  it("wraps shared facts in tags", () => {
    const text = messages(rendered);
    assert.ok(text.includes("<facts>") || text.includes("<shared-facts>"));
  });
});

describe("briefPrompt", () => {
  const rendered = briefPrompt({
    generatedAt: "2026-04-25",
    sections: {
      "Infrastructure Overview": ["Use eu-west-1 for all production workloads"],
    },
  });

  it("injects today's date programmatically", () => {
    const text = messages(rendered);
    assert.ok(text.includes("2026-04-25"));
  });

  it("constrains output to the allowed heading set", () => {
    assert.ok(ALLOWED_BRIEF_HEADINGS.length > 0);
    const text = messages(rendered);
    const hits = ALLOWED_BRIEF_HEADINGS.filter((h) => text.includes(h));
    assert.ok(hits.length >= 1, `brief prompt should mention at least one allowed heading; got ${hits.length}`);
  });
});
