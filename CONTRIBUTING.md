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
│   ├── prompts/          # Versioned LLM prompt registry
│   └── llm/              # Provider adapters (OpenAI, Bedrock, Ollama, Portkey)
│       ├── embedding/    #   embedding registry + providers
│       └── inference/    #   chat-completion registry + providers
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

# Opt-in integration suites (*.itest.ts)
npm run test:integration

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

- LLM prompt quality or extraction accuracy. Prompt-level evals live outside the default unit-test suite so day-to-day contributor tests stay fast and deterministic.
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

### Integration tests (opt-in)

The default `npm test` mocks every external call. Opt-in integration suites live in `*.itest.ts` and run through `npm run test:integration`; they may exercise multiple modules together with mocked network calls, or talk to real backing services when the test explicitly documents that requirement.

Real Qdrant + embedding integration smoke tests should use a throwaway collection and require `BIKKY_INTEGRATION=1`:

```bash
# Uses your existing ~/.bikky/config.json + QDRANT_URL (and QDRANT_API_KEY if your Qdrant requires it).
BIKKY_INTEGRATION=1 npm run test:integration
```

What a real-Qdrant smoke should do:

1. Creates a throwaway collection named `bikky-it-<short-uuid>` with the real payload indexes.
2. Exercises `memory_store` (insert, exact-dup, near-duplicate paraphrase), `memory_recall`, `memory_entity`, and `memory_forget` against live Qdrant + your real embeddings.
3. Drops the collection in `after()` regardless of pass/fail.

Cost is negligible — a handful of small embedding calls per run (≈ $0.0001 on OpenAI's `text-embedding-3-small`, free on Ollama). Files end in `.itest.ts` so the default `*.test.js` glob never picks them up.

If the near-duplicate paraphrase doesn't reinforce on your embedding model, the test logs the actual similarity score so you can re-tune `THRESHOLD_DUPLICATE` rather than failing outright.

## Adding an embedding or LLM provider

The most common contribution is **adding a new embedding or LLM provider**. Each provider is a single file. The registry dispatches by `provider.name`, so no central edits are required beyond adding one import line to the barrel.

### Embedding provider

1. Create `src/llm/embedding/providers/<name>.ts`:

   ```ts
   import {
     registerEmbeddingProvider,
     type EmbeddingProvider,
     type ResolvedEmbeddingConfig,
   } from "../registry.js";

   export const myProvider: EmbeddingProvider = {
     name: "myprovider",
     label: "My Provider",
     browserCompatible: true, // false if it needs a server-only SDK
     defaults: {
       model: "default-model",
       dimensions: 1024,
       baseUrl: "https://api.example.com", // omit if SDK-only
     },
     async embed(text, cfg) {
       // cfg.{model,baseUrl,apiKey,extra} are pre-resolved
       const resp = await fetch(`${cfg.baseUrl}/v1/embeddings`, { /* … */ });
       // throw on programmer error; return number[] on success
       return [/* embedding vector */];
     },
   };

   registerEmbeddingProvider(myProvider);
   ```

2. Add a side-effect import in `src/llm/embedding/providers/index.ts`:

   ```ts
   import "./myprovider.js";
   ```

3. Add a small unit test next to your provider (`<name>.test.ts`). Mock
   `globalThis.fetch` (see `ollama.test.ts` for the pattern). Cover at minimum:
   - success path (verifies URL, headers, body shape)
   - non-OK response handling
   - any provider-specific behaviour (auth, extra headers, fallback fields)

4. If your provider is browser-friendly, mirror it under
   `packages/ui/src/lib/embedding/providers/<name>.ts` so the UI can use it.

5. Configure it in `~/.bikky/config.json`:

   ```json
   {
     "embedding": {
       "provider": "myprovider",
       "model": "my-model",
       "api_key": "…",
       "extra": { "any-key": "any-value" }
     }
   }
   ```

   Or via env: `BIKKY_EMBEDDING_EXTRA_<KEY>=value` flows into `extra`.

### Inference (LLM) provider

Same pattern, under `src/llm/inference/providers/`. The interface is
`InferenceProvider` (see `src/llm/inference/types.ts`), the key method is
`chat(opts, cfg, log)`, and providers should **return `null`** on recoverable
errors (HTTP error, missing key, network failure) so the orchestrator can fall
back to `cfg.fallback` if configured. Throw only for programmer errors.

Configure a fallback chain via `llm.fallback_provider` in config (or
`LLM_FALLBACK_PROVIDER` env).

## Submitting changes

1. **Open an issue first** for non-trivial changes so we can align on the approach.
2. **Branch** from `main` (`git checkout -b your-feature-name`).
3. **Run the tests** in both packages before pushing.
4. **Open a PR** referencing the issue (`Closes #123`). CI will re-run tests on push.
5. We aim to review within a few business days — ping the issue if it goes quiet.

## Style

- TypeScript strict mode is on; no `any` unless interfacing with external SDK types (use a focused local interface to constrain the surface area).
- We prefer small, pure functions and clear module boundaries to elaborate abstractions.
- Tests live next to the source they cover (`foo.ts` + `foo.test.ts`).
- Providers must not call `process.exit`, log to stdout, or modify global state beyond their own module-scope cache.
- Heavy SDKs (e.g. `@aws-sdk/*`) **must be `await import(...)`-loaded inside the provider's `embed`/`chat`** so users on lighter providers don't pay the bundle cost.
- Comments explain *why*, not *what* — the code shows the *what*.

## License

By contributing, you agree that your contributions will be licensed under the project's [AGPL-3.0-or-later](https://github.com/bikky-dev/bikky/blob/main/LICENSE) license.

## Code of conduct

Be kind. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
