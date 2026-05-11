# Research: Origin Metadata

## Current model

- Bikky currently stores provenance across multiple fields:
  - `source` is a coarse enum (`agent`, `system`, `user`, `docs`).
  - `actor_id` is a top-level indexed payload field.
  - `actor_label` and `actor_source` are stored in generic metadata by MCP helpers.
- `src/provenance/actor.ts` resolves an actor from explicit MCP input, env, config, or Git fallback. This is useful prior art for normalization, but the explicit MCP override should not become the human user source of truth.
- There is no canonical object that says which configured human user, which automated actor, which surface, and which operation produced or mutated a memory.

## Final design direction

- Breaking changes are acceptable.
- `origin` becomes the canonical provenance object for new writes.
- `origin.user` is the configured/provisioned human identity. MCP callers do not provide it.
- `origin.agent` is inferred by the runtime surface: coding agent, daemon, UI/API, CLI, docs importer, system, or unknown.
- `origin.interface` records the entry surface.
- `origin.operation` records create/update/delete/verify/forget/review/correct/reinforce/supersede/feedback semantics plus tool/route/subsystem/outcome details.
- Identity sources to implement: `config`, `shell`, `git`, `env`, `hostname`. Do not implement `runtime`, `legacy`, or `default`; hostname is the fallback when automated detection fails.
- Keep memory classification fields such as `kind` and `memory_subtype` outside `origin`.

## Write surfaces to inspect/wire

- MCP:
  - `src/mcp/tools.ts`
  - `src/mcp/types.ts`
  - `src/mcp/helpers.ts`
- Daemon:
  - `src/daemon/qdrant.ts`
  - `src/daemon/extraction.ts`
  - `src/daemon/session-index.ts`
  - `src/daemon/episode-summary.ts`
  - `src/daemon/workstream-summary.ts`
  - `src/daemon/entity-typing.ts`
- UI/API:
  - `packages/ui/src/routes/memory.ts`
  - `packages/ui/src/lib/qdrant.ts`
- Config/install:
  - `src/config.ts`
  - `src/install.ts`
  - `src/lifecycle.ts`
  - `src/provenance/actor.ts`

## Risks and considerations

- Existing Qdrant records may still have top-level `source` / `actor_id`; read paths may need a compatibility adapter, but new writes should be origin-first.
- Tests need to cover identity fallback order, hostname fallback, MCP no-spoofing behavior, mutation `last_operation_origin`, daemon origins, and UI/API origins.
- Existing indexes/filters may reference `source` and `actor_id`; replacing those may require search/filter updates or an intentional compatibility bridge.

## Follow-up research: Memory UI filtering and provenance display

- Issue #150 tracks the follow-up PR for the local dashboard/list filtering and provenance display changes.
- The default Memory UI should show current user-facing memories only. Internal telemetry (`kind=telemetry`), system lifecycle records (`session_index`, `episode`, `workstream`), entity sidecars, and superseded/archive records are useful diagnostics but should not appear by default.
- `packages/ui/src/routes/memory.ts` is the central route layer for browse/search/stats defaults; `packages/ui/src/lib/qdrant.ts` is the central Qdrant filter builder.
- The React list/detail surfaces share the `Fact` type in `packages/ui/app/src/components/FactCard.tsx`; provenance display helpers can live there and be reused by `MemoryFact.tsx`.
- Daemon quality rollup telemetry writes through `src/daemon/quality-rollups.ts`; it must pass loaded `BikkyConfig` into `buildOperationOrigin` so configured identity wins over Git fallback.
