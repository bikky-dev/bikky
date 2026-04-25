# Contributing to bikky

Thanks for considering a contribution! This guide focuses on the most common
contribution: **adding a new embedding or LLM provider**.

## Project layout

- `src/llm/embedding/` — embedding registry + built-in providers (Ollama, OpenAI, Bedrock, Portkey)
- `src/llm/inference/` — chat-completion registry + built-in providers (same set)
- `packages/ui/src/lib/embedding/` — UI-side embedding registry (browser-friendly providers only)
- `src/config.ts` — flat config with a generic `extra` bag for provider-specific options

## Adding an embedding provider

Each provider is a single file. The registry dispatches by `provider.name`, so
no central edits are required beyond adding one import line to the barrel.

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

## Adding an inference (LLM) provider

Same pattern, under `src/llm/inference/providers/`. The interface is
`InferenceProvider` (see `src/llm/inference/types.ts`), the key method is
`chat(opts, cfg, log)`, and providers should **return `null`** on recoverable
errors (HTTP error, missing key, network failure) so the orchestrator can fall
back to `cfg.fallback` if configured. Throw only for programmer errors.

Configure a fallback chain via `llm.fallback_provider` in config (or
`LLM_FALLBACK_PROVIDER` env).

## Running checks

```sh
npm run build      # tsc
npm test           # all tests with concurrency=1 (avoids config-file races)
npm run lint
```

UI:

```sh
cd packages/ui && npm run build
```

## Conventions

- TypeScript strict mode; no `any` unless interfacing with external SDK types
  (use a focused local interface to constrain the surface area)
- Tests live next to the source they cover (`foo.ts` + `foo.test.ts`)
- Providers must not call `process.exit`, log to stdout, or modify global state
  beyond their own module-scope cache
- Heavy SDKs (e.g. `@aws-sdk/*`) **must be `await import(...)`-loaded inside
  the provider's `embed`/`chat`** so users on lighter providers don't pay the
  bundle cost
