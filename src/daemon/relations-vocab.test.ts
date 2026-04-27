import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_RELATION_TYPES,
  GENERIC_ENTITY_STOP_LIST,
  canonicalTypesForPrompt,
  isGenericEntity,
  mapToCanonical,
} from "./relations-vocab.js";

test("isGenericEntity: filters generic nouns", () => {
  assert.equal(isGenericEntity("user"), true);
  assert.equal(isGenericEntity("USER"), true);
  assert.equal(isGenericEntity("  data  "), true);
  assert.equal(isGenericEntity("error"), true);
  assert.equal(isGenericEntity("session"), true);
});

test("isGenericEntity: keeps real entities", () => {
  assert.equal(isGenericEntity("bikky"), false);
  assert.equal(isGenericEntity("qdrant"), false);
  assert.equal(isGenericEntity("tg-bot"), false);
  assert.equal(isGenericEntity("workspace_id"), false);
});

test("GENERIC_ENTITY_STOP_LIST: includes the obvious noise words", () => {
  for (const word of ["user", "data", "test", "error", "fact", "memory", "session"]) {
    assert.equal(GENERIC_ENTITY_STOP_LIST.has(word), true, `expected ${word} in stop list`);
  }
});

test("mapToCanonical: keeps canonical labels unchanged", () => {
  for (const t of CANONICAL_RELATION_TYPES) {
    const r = mapToCanonical(t);
    assert.equal(r.canonical, t);
    assert.equal(r.changed, false);
    assert.equal(r.inVocabulary, true);
  }
});

test("mapToCanonical: 'uses' → 'depends-on'", () => {
  const r = mapToCanonical("uses");
  assert.equal(r.canonical, "depends-on");
  assert.equal(r.changed, true);
  assert.equal(r.inVocabulary, true);
});

test("mapToCanonical: 'depends_on' (snake) → 'depends-on'", () => {
  const r = mapToCanonical("depends_on");
  assert.equal(r.canonical, "depends-on");
  assert.equal(r.inVocabulary, true);
});

test("mapToCanonical: 'Sends To' (mixed case + space) → 'calls'", () => {
  const r = mapToCanonical("Sends To");
  assert.equal(r.canonical, "calls");
  assert.equal(r.changed, true);
  assert.equal(r.inVocabulary, true);
});

test("mapToCanonical: 'manages' → 'owns'", () => {
  assert.equal(mapToCanonical("manages").canonical, "owns");
});

test("mapToCanonical: 'replaces' → 'succeeds'", () => {
  assert.equal(mapToCanonical("replaces").canonical, "succeeds");
});

test("mapToCanonical: unknown type passes through normalised, marked out-of-vocab", () => {
  const r = mapToCanonical("bikkifies");
  assert.equal(r.canonical, "bikkifies");
  assert.equal(r.inVocabulary, false);
});

test("mapToCanonical: unknown type with spaces collapsed", () => {
  const r = mapToCanonical("Wiggles  Around");
  assert.equal(r.canonical, "wiggles-around");
  assert.equal(r.inVocabulary, false);
});

test("canonicalTypesForPrompt: includes every canonical type", () => {
  const block = canonicalTypesForPrompt();
  for (const t of CANONICAL_RELATION_TYPES) {
    assert.ok(block.includes(t), `missing ${t} in prompt block`);
  }
});
