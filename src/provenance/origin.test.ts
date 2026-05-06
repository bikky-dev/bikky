import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildOperationOrigin,
  inferUserIdentity,
  normalizeOriginId,
  resolveAgentIdentity,
  resolveUserIdentity,
  sanitizeOriginMetadata,
} from "./origin.js";
import { CONFIG_DEFAULTS, type BikkyConfig } from "../config.js";

test("normalizeOriginId hashes email-shaped values", () => {
  const normalized = normalizeOriginId("person@example.com");
  assert.match(normalized ?? "", /^email:[0-9a-f]{12}$/);
  assert.ok(!normalized?.includes("person@example.com"));
});

test("resolveUserIdentity prefers configured user identity", () => {
  const cfg: BikkyConfig = {
    ...CONFIG_DEFAULTS,
    identity: {
      ...CONFIG_DEFAULTS.identity,
      user_id: "saber-local",
      user_name: "Saber",
    },
  };
  assert.deepEqual(resolveUserIdentity({
    config: cfg,
    env: { BIKKY_USER_ID: "env-user", BIKKY_USER_NAME: "Env User" },
    shellUsername: "shell-user",
    hostname: "host-1",
    cwd: "/tmp/does-not-exist",
  }), {
    type: "user",
    id: "saber-local",
    name: "Saber",
    source: "config",
  });
});

test("inferUserIdentity uses explicit env before shell and hostname", () => {
  assert.deepEqual(inferUserIdentity({
    env: { BIKKY_USER_ID: "env-user", BIKKY_USER_NAME: "Env User" },
    shellUsername: "shell-user",
    hostname: "host-1",
    cwd: "/tmp/does-not-exist",
  }), {
    type: "user",
    id: "env-user",
    name: "Env User",
    source: "env",
  });
});

test("resolveUserIdentity falls back to shell identity before hostname", () => {
  const user = resolveUserIdentity({
    config: null,
    env: {},
    shellUsername: "Local User",
    hostname: "host-1",
    cwd: "/tmp/does-not-exist",
  });
  assert.equal(user.type, "user");
  assert.equal(user.id, "shell:local-user");
  assert.equal(user.name, "Local User");
  assert.equal(user.source, "shell");
});

test("resolveUserIdentity uses hostname when all automated detection fails", () => {
  const user = resolveUserIdentity({
    config: null,
    env: {},
    shellUsername: null,
    hostname: "fallback-host",
    cwd: "/tmp/does-not-exist",
  });
  assert.deepEqual(user, {
    type: "user",
    id: "host:fallback-host",
    name: "fallback-host",
    source: "hostname",
  });
});

test("resolveAgentIdentity uses env agent identity when present", () => {
  const agent = resolveAgentIdentity({
    interface: "mcp",
    env: { BIKKY_AGENT_ID: "copilot", BIKKY_AGENT_NAME: "GitHub Copilot" },
    hostname: "host-1",
  });
  assert.deepEqual(agent, {
    type: "coding_agent",
    id: "copilot",
    name: "GitHub Copilot",
    source: "env",
  });
});

test("resolveAgentIdentity falls back to hostname attribution", () => {
  const agent = resolveAgentIdentity({
    interface: "daemon",
    env: {},
    hostname: "host-1",
  });
  assert.equal(agent.type, "daemon");
  assert.equal(agent.id, "daemon:host-1");
  assert.equal(agent.name, "Bikky daemon on host-1");
  assert.equal(agent.source, "hostname");
});

test("sanitizeOriginMetadata keeps only bounded primitive values", () => {
  assert.deepEqual(sanitizeOriginMetadata({
    "task key": "x".repeat(300),
    count: 2,
    ok: true,
    none: null,
    nested: { no: true },
  }), {
    task_key: "x".repeat(256),
    count: 2,
    ok: true,
    none: null,
  });
});

test("buildOperationOrigin creates canonical operation provenance", () => {
  const origin = buildOperationOrigin({
    interface: "mcp",
    action: "create",
    tool: "memory_store",
    config: null,
    env: { BIKKY_USER_ID: "saber", BIKKY_AGENT_ID: "copilot" },
    shellUsername: null,
    hostname: "host-1",
    cwd: "/tmp/does-not-exist",
    metadata: { destination: "default" },
  });

  assert.equal(origin.schema_version, 1);
  assert.equal(origin.user?.id, "saber");
  assert.equal(origin.user?.source, "env");
  assert.equal(origin.agent.id, "copilot");
  assert.equal(origin.agent.type, "coding_agent");
  assert.equal(origin.interface, "mcp");
  assert.deepEqual(origin.operation, { action: "create", tool: "memory_store" });
  assert.deepEqual(origin.metadata, { destination: "default" });
});
