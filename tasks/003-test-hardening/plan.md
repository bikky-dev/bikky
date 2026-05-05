# Plan: Bikky test hardening

## Approach

Implement the audit recommendations in pragmatic slices, prioritizing tests that protect public/runtime behavior and minimizing production-code changes. If a test exposes a bug, fix only the targeted behavior covered by the plan.

## Planned test slices

1. Core routing/config primitives
   - Add `src/lib/qdrant-pool.test.ts` for collection lookup, unknown destination errors, fan-out partial failure, readiness tracking, and rebuild behavior.
   - Extend routing/search-scope/config tests for edge cases found in the audit where the existing pure tests are thin.

2. Daemon edge and integration tests
   - Add Copilot disabled watcher coverage in `src/daemon/watcher.test.ts`.
   - Add transcript truncation/rotation offset tests in `src/daemon/transcript-sources.test.ts`.
   - Add `src/daemon/consolidation.test.ts` for contradiction result parsing and scheduler/no-op behavior where practical.
   - Extend relations/entity-typing tests around maintenance cursors/backoff/deferral if seams are testable without broad refactor.

3. MCP tool handler tests
   - Add `src/mcp/tools.test.ts` using a fake server/tool collector.
   - Cover ready guards, `memory_store` destination/dedup/redaction behavior, `memory_recall` output/destination errors, and ID-based mutation not-found behavior.

4. Privacy and UI server tests
   - Add direct UI redaction unit tests in `packages/ui/src/lib/redaction.test.ts`.
   - Extend `packages/ui/src/routes/memory.test.ts` for multi-destination browse/search/destinations endpoint behavior.

5. CLI/package tests
   - Add subprocess-style tests for CLI public commands where feasible without launching long-running MCP/daemon processes.
   - Add test coverage for package verification script checks if helpers can be extracted without weakening the script.

6. React app/client helper tests
   - Add tests for pure client helpers first (`apiFetch`, destination store, stats cache).
   - Add React component tests only if an appropriate DOM test setup can be added without bloating the package or destabilizing CI.

## Validation

- Run focused tests for each changed area while implementing.
- Run full local validation before committing:
  - `npm run check`
  - `npm test`
  - `cd packages/ui && npm run typecheck && npm test && npm run build`
  - `npm run verify:package`

## Risk controls

- Keep all tests deterministic and mock external services.
- Do not call live Qdrant, LLM, embeddings, browsers, or infrastructure.
- Do not modify `main` without explicit approval.
- If new test dependencies are required, keep them dev-only and justify them before adding.
