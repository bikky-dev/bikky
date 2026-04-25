# Contributing to bikky

Thanks for your interest in bikky! We welcome PRs of all sizes — from typo fixes to new daemon features. This document covers the practical bits: how the repo is laid out, how to run the tests, and what we look for in a contribution.

## Repository layout

bikky is a small monorepo:

```
.
├── src/                  # Core CLI + MCP server + daemon (published as `bikky`)
│   ├── cli/              # `bikky <subcommand>` entrypoints
│   ├── daemon/           # Background workers: extraction, consolidation, staleness, …
│   ├── mcp/              # MCP server (the surface AI agents call into)
│   └── llm/              # Provider adapters (OpenAI, Bedrock, Ollama)
└── packages/
    └── ui/               # Local web UI (`bikky-ui`) — Hono server + React frontend
        ├── src/lib/      #   - config, qdrant client, embeddings
        ├── src/routes/   #   - REST API routes
        └── app/          #   - React/Vite frontend
```

## Setup

```bash
git clone https://github.com/bikky-dev/bikky.git
cd bikky
npm install
cd packages/ui && npm install && cd ../..
```

## Running the tests

We use the Node.js built-in test runner ([`node:test`](https://nodejs.org/api/test.html)) — no Jest, no Vitest, no extra dependencies.

```bash
# Core (CLI, daemon, MCP server) — 300+ tests
npm test

# UI server + libraries — 50+ tests
cd packages/ui && npm test
```

Both packages compile TypeScript into `dist/` first and then run the compiled `*.test.js` files. The UI test suite uses `--test-isolation=process --test-concurrency=1` because several tests share `~/.bikky/config.json` on the developer's machine; running them in isolation avoids flakiness.

> **Note on `~/.bikky/config.json`** — UI tests back up your real config in `before()` and restore it in `after()`. If a test crashes mid-run the file *should* survive, but if you ever see odd behaviour after a failed test run, just delete the file and re-run `bikky setup`.

### What we test

We aim for **focused, fast unit tests** that lock in behaviour without being a maintenance tax:

- Pure functions (filter builders, hashers, parsers) — exhaustive cases.
- Stateful modules (config loaders, lifecycle/PID, daemons) — happy path + a couple of failure modes.
- Network clients (Qdrant, embeddings, LLM providers) — mock `globalThis.fetch` and assert on the request, never call a real backend.
- HTTP routes (Hono) — exercise via `app.fetch(new Request(...))` against the real router with mocked underlying calls.

We deliberately **do not** test:

- LLM prompt quality or extraction accuracy. Those live in the separate [`bikky-evals`](https://github.com/bikky-dev/bikky-evals) repo, which uses DeepEval for prompt-level scoring.
- Implementation details (private function internals, exact log strings) — these change often and tests that pin them slow contributors down.
- The React frontend — the testable surface there is small; we rely on type-checking and manual smoke tests.

### Adding a new test

Tests live alongside the source as `*.test.ts`:

```
src/foo.ts       # source
src/foo.test.ts  # tests
```

Use the [`node:test`](https://nodejs.org/api/test.html) `describe/it/before/after` API and `node:assert/strict`. For mocking, prefer **dependency injection** (e.g. the `StaleDeps` pattern in `src/daemon/staleness.ts`) over module mocking — it keeps tests deterministic and the production code easier to reason about.

Good references for new tests:

| Pattern                          | Reference                              |
|----------------------------------|----------------------------------------|
| Filesystem with backup/restore   | `src/lifecycle.test.ts`                |
| Temp dir with `mkdtemp`          | `src/logger.test.ts`                   |
| Env-based path override          | `src/llm/telemetry.test.ts`            |
| Dependency injection for daemons | `src/daemon/staleness.test.ts`         |
| Mocking `globalThis.fetch`       | `src/mcp/api.test.ts`, `packages/ui/src/lib/qdrant.test.ts` |
| Hono route via `app.fetch`       | `packages/ui/src/routes/memory.test.ts` |

### Integration tests (opt-in, real Qdrant)

The default `npm test` mocks every external call. We also ship one **opt-in** end-to-end smoke test that talks to a real Qdrant Cloud instance and a real embedding provider — it's the only thing that catches filter-shape rejections, payload-index mismatches, vector-dimension drift, and whether the dedup similarity thresholds (`THRESHOLD_DUPLICATE`, `THRESHOLD_RELATED`) actually correspond to near-duplicates against your embedding model.

```bash
# Uses your existing ~/.bikky/config.json + QDRANT_URL/QDRANT_API_KEY env.
BIKKY_INTEGRATION=1 npm run test:integration
```

What it does:

1. Creates a throwaway collection named `bikky-it-<short-uuid>` with the real payload indexes.
2. Exercises `memory_store` (insert, exact-dup, near-duplicate paraphrase), `memory_recall`, `memory_entity`, and `memory_forget` against live Qdrant + your real embeddings.
3. Drops the collection in `after()` regardless of pass/fail.

Cost is negligible — a handful of small embedding calls per run (≈ $0.0001 on OpenAI's `text-embedding-3-small`, free on Ollama). Files end in `.itest.ts` so the default `*.test.js` glob never picks them up.

If the near-duplicate paraphrase doesn't reinforce on your embedding model, the test logs the actual similarity score so you can re-tune `THRESHOLD_DUPLICATE` rather than failing outright.

## Submitting changes

1. **Open an issue first** for non-trivial changes so we can align on the approach.
2. **Branch** from `main` (`git checkout -b your-feature-name`).
3. **Run the tests** in both packages before pushing.
4. **Open a PR** referencing the issue (`Closes #123`). CI will re-run tests on push.
5. We aim to review within a few business days — ping the issue if it goes quiet.

## Style

- TypeScript strict mode is on; no `any` unless you have a good reason.
- We prefer small, pure functions and clear module boundaries to elaborate abstractions.
- Comments explain *why*, not *what* — the code shows the *what*.

## License

By contributing, you agree that your contributions will be licensed under the project's [AGPL-3.0-or-later](LICENSE) license.

## Code of conduct

Be kind. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
