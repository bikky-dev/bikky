import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeActorId, resolveActorIdentity } from "./actor.js";
import { CONFIG_DEFAULTS, type BikkyConfig } from "../config.js";

test("normalizeActorId slugifies stable actor IDs", () => {
  assert.equal(normalizeActorId(" Saber Zrelli "), "saber-zrelli");
});

test("normalizeActorId hashes email-shaped values", () => {
  const normalized = normalizeActorId("person@example.com");
  assert.match(normalized ?? "", /^email:[0-9a-f]{12}$/);
  assert.ok(!normalized?.includes("person@example.com"));
});

test("resolveActorIdentity prefers explicit input over env and config", () => {
  const cfg: BikkyConfig = {
    ...CONFIG_DEFAULTS,
    identity: { ...CONFIG_DEFAULTS.identity, actor_id: "config-actor", actor_label: "Config Actor" },
  };
  const actor = resolveActorIdentity({
    actorId: "input-actor",
    actorLabel: "Input Actor",
    config: cfg,
    env: { BIKKY_ACTOR_ID: "env-actor", BIKKY_ACTOR_LABEL: "Env Actor" },
    useGitFallback: false,
  });
  assert.deepEqual(actor, {
    actor_id: "input-actor",
    actor_label: "Input Actor",
    source: "input",
  });
});

test("resolveActorIdentity uses env before config", () => {
  const cfg: BikkyConfig = {
    ...CONFIG_DEFAULTS,
    identity: { ...CONFIG_DEFAULTS.identity, actor_id: "config-actor", actor_label: "Config Actor" },
  };
  const actor = resolveActorIdentity({
    config: cfg,
    env: { BIKKY_ACTOR_ID: "env-actor", BIKKY_ACTOR_LABEL: "Env Actor" },
    useGitFallback: false,
  });
  assert.equal(actor.actor_id, "env-actor");
  assert.equal(actor.actor_label, "Env Actor");
  assert.equal(actor.source, "env");
});

test("resolveActorIdentity omits actor when no source is configured and git fallback is disabled", () => {
  const actor = resolveActorIdentity({ env: {}, useGitFallback: false });
  assert.deepEqual(actor, {});
});
