import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeKey,
  emptyRegistry,
  extractDeterministicKey,
  registerCanonical,
  resolveWorkstreamKey,
} from "./workstream-resolver.js";

test("canonicalizeKey: lowercase + kebab-case + ascii-fold", () => {
  assert.equal(canonicalizeKey("Fix WA Cron"), "fix-wa-cron");
  assert.equal(canonicalizeKey("fix_wa_cron"), "fix-wa-cron");
  assert.equal(canonicalizeKey("  Fix  WA   Cron  "), "fix-wa-cron");
  assert.equal(canonicalizeKey("#GH-123"), "gh-123");
  assert.equal(canonicalizeKey("café-déjà"), "cafe-deja");
  assert.equal(canonicalizeKey(""), "");
  assert.equal(canonicalizeKey("---"), "");
});

test("extractDeterministicKey: GitHub issue/PR refs", () => {
  assert.deepEqual(extractDeterministicKey("see #123 for context"), {
    key: "gh-123",
    source: "issue",
    confidence: 0.9,
  });
  assert.deepEqual(extractDeterministicKey("opened GH-44 yesterday"), {
    key: "gh-44",
    source: "issue",
    confidence: 0.9,
  });
  assert.deepEqual(extractDeterministicKey("see issue 7"), {
    key: "gh-7",
    source: "issue",
    confidence: 0.85,
  });
});

test("extractDeterministicKey: JIRA-style keys", () => {
  assert.deepEqual(extractDeterministicKey("PROJ-456 was rejected"), {
    key: "proj-456",
    source: "jira",
    confidence: 0.95,
  });
});

test("extractDeterministicKey: branch names", () => {
  assert.deepEqual(extractDeterministicKey("on feat/extraction-reliability today"), {
    key: "extraction-reliability",
    source: "branch",
    confidence: 0.85,
  });
});

test("extractDeterministicKey: task-folder slugs", () => {
  assert.deepEqual(extractDeterministicKey("editing tasks/252-bikky-extraction-reliability/plan.md"), {
    key: "252-bikky-extraction-reliability",
    source: "task-folder",
    confidence: 0.95,
  });
});

test("extractDeterministicKey: precedence (task-folder beats issue)", () => {
  // task-folder pattern is first in the list, so it wins
  assert.deepEqual(
    extractDeterministicKey("see #99 in tasks/100-foo-bar/plan.md"),
    { key: "100-foo-bar", source: "task-folder", confidence: 0.95 },
  );
});

test("extractDeterministicKey: returns null when no patterns match", () => {
  assert.equal(extractDeterministicKey("random chatter without any keys"), null);
  assert.equal(extractDeterministicKey(""), null);
});

test("extractDeterministicKey: avoids false JIRA matches inside code-like tokens", () => {
  // Hyphenated identifiers should not be misread as JIRA keys
  assert.equal(extractDeterministicKey("see HTTP-200 status"), null);
  assert.equal(extractDeterministicKey("UTF-8 encoding"), null);
});

test("resolveWorkstreamKey: deterministic wins over LLM key", () => {
  const result = resolveWorkstreamKey({
    transcript: "fixing #44 today",
    llmKey: "some-other-key",
  });
  assert.equal(result.key, "gh-44");
  assert.equal(result.source, "deterministic");
});

test("resolveWorkstreamKey: deterministic match against existing alias", () => {
  const registry = emptyRegistry();
  registerCanonical(registry, "issue-44", ["gh-44", "GH-44"]);
  const result = resolveWorkstreamKey({
    transcript: "working on #44",
    registry,
  });
  assert.equal(result.key, "issue-44");
  assert.equal(result.source, "alias");
});

test("resolveWorkstreamKey: LLM key absorbed by alias registry", () => {
  const registry = emptyRegistry();
  registerCanonical(registry, "fix-wa-cron", ["wa cron fix", "fix the wa cron"]);
  const result = resolveWorkstreamKey({
    transcript: "no anchors here",
    llmKey: "Fix the WA Cron",
    registry,
  });
  assert.equal(result.key, "fix-wa-cron");
  assert.equal(result.source, "alias");
});

test("resolveWorkstreamKey: LLM key registered as new canonical", () => {
  const result = resolveWorkstreamKey({
    transcript: "no anchors here",
    llmKey: "Brand New Project",
  });
  assert.equal(result.key, "brand-new-project");
  assert.equal(result.source, "llm-new");
});

test("resolveWorkstreamKey: returns null when no key available", () => {
  const result = resolveWorkstreamKey({
    transcript: "no anchors",
    llmKey: null,
  });
  assert.equal(result.key, null);
  assert.equal(result.source, "none");
});

test("resolveWorkstreamKey: LLM key that canonicalises to empty returns null", () => {
  const result = resolveWorkstreamKey({
    transcript: "no anchors",
    llmKey: "---",
  });
  assert.equal(result.key, null);
  assert.equal(result.source, "none");
});

test("registerCanonical: aliases reverse-index correctly", () => {
  const registry = emptyRegistry();
  registerCanonical(registry, "main-task", ["alias-one", "Alias_Two"]);
  assert.equal(registry.aliasToCanonical.get("main-task"), "main-task");
  assert.equal(registry.aliasToCanonical.get("alias-one"), "main-task");
  assert.equal(registry.aliasToCanonical.get("alias-two"), "main-task");
  const aliases = registry.canonicalToAliases.get("main-task");
  assert.ok(aliases?.has("main-task"));
  assert.ok(aliases?.has("alias-one"));
  assert.ok(aliases?.has("alias-two"));
});
