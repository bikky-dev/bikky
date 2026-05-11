# Plan: Origin Metadata

## Problem

Bikky provenance is split across `source`, `actor_id`, `actor_label`, and generic metadata. That makes it hard to answer who the configured user was, which automated agent/surface acted, and which operation created or mutated a memory. The new design should make `origin` the canonical provenance object.

## Canonical shape

```ts
interface OriginIdentity {
  type: "user" | "coding_agent" | "daemon" | "ui" | "api" | "cli" | "docs" | "system" | "unknown";
  id: string | null;
  name: string | null;
  source: "config" | "shell" | "git" | "env" | "hostname";
}

interface OperationOrigin {
  schema_version: 1;
  user: OriginIdentity | null;
  agent: OriginIdentity;
  interface: "mcp" | "daemon" | "ui" | "api" | "cli" | "system";
  operation: {
    action: "create" | "update" | "delete" | "verify" | "forget" | "review" | "correct" | "reinforce" | "supersede" | "feedback";
    tool?: string;
    route?: string;
    subsystem?: string;
    outcome?: string;
  };
  metadata?: Record<string, string | number | boolean | null>;
}
```

Memory classification fields such as `kind` and `memory_subtype` remain outside `origin`.

## Implementation plan

1. Add provenance types/helpers.
   - Create `src/provenance/origin.ts`.
   - Reuse email-like ID normalization from `src/provenance/actor.ts`.
   - Resolve user identity from config/env/git/shell/hostname, with hostname fallback.
   - Resolve agent identity from MCP/daemon/UI/API/CLI/system context.
   - Bound metadata to primitive values and safe string lengths.

2. Extend config and setup.
   - Add `identity.user_id` / `identity.user_name` to `src/config.ts`.
   - Keep legacy `actor_id` / `actor_label` only if needed for reading old config, not as the public write model.
   - Update setup/install/start path to provision missing user identity once without overwriting configured values.

3. Wire MCP.
   - Remove/deprecate public `actor_id` write input where feasible.
   - Do not add MCP `origin` or `user` override input.
   - Add `origin` to creation paths and `last_operation_origin` to mutation paths.
   - Update structured/text read output.

4. Wire daemon.
   - Add daemon origin defaults to central `storeFact()`.
   - Add origins to direct daemon upserts for session index, episode summary, workstream summary, and entity typing.

5. Wire UI/API.
   - Add origin generation to create/update/delete routes.
   - Update UI Qdrant payload types.

6. Update tests and docs.
   - Add origin helper/config tests.
   - Update MCP, daemon, UI, and serialization tests.
   - Update README/config/API docs for canonical origin semantics and hostname fallback.

7. Validate.
   - Run `npm run check`.
   - Run `npm test`.
   - Run `cd packages/ui && npm run typecheck && npm test && npm run build`.
   - Run `npm run verify:package`.

## Acceptance criteria

- New writes store canonical `origin`.
- Mutation-only operations preserve creation `origin` and set `last_operation_origin`.
- MCP callers cannot spoof `origin.user`.
- Identity source values are limited to `config`, `shell`, `git`, `env`, and `hostname`.
- Hostname is used when all other identity detection fails.
- `kind` and `memory_subtype` remain outside `origin`.
- Tests cover helper resolution, write paths, mutation paths, daemon origins, UI/API origins, and read serialization.

## Follow-up plan: issue #150

1. Package the local Memory dashboard/list filtering changes.
   - Keep default browse/search/stats scoped to current user-facing memories.
   - Preserve explicit diagnostic access for telemetry, system lifecycle records, and superseded records.

2. Package the local provenance display changes.
   - Show configured user/origin on memory cards.
   - Show user, origin, agent, and last-operation provenance on the memory detail page.
   - Keep legacy fallbacks for records that only have `user_name`, `metadata.actor_label`, `source`, or `actor_id`.

3. Package the quality-rollup identity fix.
   - Pass `BikkyConfig` into quality-rollup origin generation so config identity is used.
   - Keep regression coverage for configured identity.

4. Verify before commit.
   - Run root `npm test`.
   - Run `cd packages/ui && npm test`.
   - Run `cd packages/ui && npm run build`.

5. Open and merge a focused PR.
   - Branch from `main`.
   - Reference `Closes #150` in the PR.
   - Wait for GitHub checks before merging into `main`.
