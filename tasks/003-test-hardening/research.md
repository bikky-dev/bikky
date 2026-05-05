# Research: Bikky test hardening

## Goal

Add tests for the high-priority gaps identified in the read-only codebase analysis, focusing on the highest-risk integration seams rather than only same-name unit-test gaps.

## Existing baseline

- Core package uses Node's built-in test runner.
- UI package also uses Node's built-in test runner for server/lib tests and Vite for browser build.
- Local validation command set already used successfully:
  - `npm run check`
  - `npm test`
  - `cd packages/ui && npm run typecheck && npm test && npm run build`
  - `npm run verify:package`
- Existing source/test counts from the audit:
  - 135 source files under `src` and `packages/ui/src`
  - 52 test files

## High-priority gaps from audit

1. MCP tool handlers are mostly untested:
   - `src/mcp/tools.ts`
   - `src/mcp/api.ts`
   - Risks: actual registered tool behavior, ready guards, destination errors, dedup/supersede, JSON output, ID-based mutations, redaction at integration boundaries.

2. Daemon integration behavior needs coverage:
   - `src/daemon/extraction.ts`
   - `src/daemon/consolidation.ts`
   - `src/daemon/relations.ts`
   - `src/daemon/entity-typing.ts`
   - Risks: tick orchestration, offsets, maintenance cursors, disabled/no-ready no-ops, deferral/backoff, contradiction outcomes.

3. UI multi-destination route behavior needs coverage:
   - `packages/ui/src/routes/memory.ts`
   - Risks: `destination=all`, named/unknown destinations, safe destination metadata, merged search/browse output.

4. React app behavior has no tests:
   - `packages/ui/app/src/pages/Memory.tsx`
   - `packages/ui/app/src/pages/MemoryFact.tsx`
   - `packages/ui/app/src/components/DestinationSelector.tsx`
   - Risks: user-facing URL/query/destination state. This likely requires new browser-style test dependencies and should be handled carefully.

5. Privacy redaction needs integration coverage:
   - `src/mcp/tools.ts`
   - `packages/ui/src/lib/redaction.ts`
   - Risks: proving secrets do not reach embeddings/Qdrant payloads/tool responses; metadata policy is ambiguous.

6. Watcher/transcript edge cases:
   - `src/daemon/watcher.ts`
   - `src/daemon/transcript-sources.ts`
   - Risks: Copilot disabled watcher currently looks suspicious because Claude has disabled coverage but Copilot discovery may not check enabled; transcript rotation/truncation offsets may get stuck.

7. CLI/package and runtime primitives:
   - `src/cli.ts`
   - `src/postinstall.ts`
   - `scripts/verify-package.mjs`
   - `src/lib/qdrant-pool.ts`
   - `src/config.ts`, `src/routing.ts`, `src/search-scope.ts`
   - Risks: public npm entrypoints, package publish safety, partial destination readiness/fan-out edge cases, invalid runtime config.

## Scope notes

- The user asked to implement all identified tests.
- Some tests may expose real bugs, especially watcher disabled handling and transcript truncation behavior. Minimal code fixes needed to make in-scope tests pass are allowed, but broader refactors should be avoided.
- React behavioral tests may require introducing a browser DOM test dependency. Prefer server/lib/core tests first and only add dependencies if necessary for meaningful React coverage.

## Follow-up research notes

- PR #126 is open from `test/high-priority-coverage` and all required checks were green before the follow-up expansion.
- Additional daemon extraction coverage can use real transcript discovery from temp Claude transcript files to avoid mocking private module internals; mocked global fetch can handle Ollama-compatible embeddings, LLM chat completions, and Qdrant REST writes.
- MCP tool handler tests can continue using the fake `McpServer.tool()` collector; API functions route through Qdrant REST clients and embedding providers, so global fetch mocks are sufficient for happy-path write coverage.
- UI app/client helpers live under `packages/ui/app/src`, while current UI tests only compile `packages/ui/src`. Adding Vite/Vitest-style app tests may require dev tooling changes; keep that isolated to UI dev dependencies and scripts if used.
- `scripts/verify-package.mjs` currently executes immediately and is not importable. Unit coverage requires extracting pure helpers into a source module or making the script import-safe while preserving CLI behavior.
