# Local Qdrant + hosted models config

This setup keeps Qdrant local while a hosted gateway/provider handles extraction, curation, and recall.

## What you need

- Qdrant running locally, usually with Docker.
- A Portkey API key (recommended) — one key, many upstream providers, with built-in routing, fallbacks, and observability. Get one at [portkey.ai](https://portkey.ai). Or use OpenAI / Bedrock directly.

For both `embedding.provider` and `llm.provider`, possible values are `portkey`, `openai`, or `bedrock` for hosted models. `ollama` is also supported when you want local model calls.

## Config (recommended: Portkey)

Save this as `~/.bikky/config.json`:

```json
{
  "qdrant_url": "http://localhost:6333",
  "qdrant_api_key": "",
  "embedding": {
    "provider": "portkey",
    "model": "@openai/text-embedding-3-small",
    "dimensions": 1024
  },
  "llm": {
    "provider": "portkey",
    "model": "@anthropic/claude-sonnet-4"
  }
}
```

Then export the gateway key:

```bash
export PORTKEY_API_KEY="pk-..."
```

bikky uses **1024-dimensional embeddings** as the canonical default. This is portable across modern providers (OpenAI 3-small/3-large via Matryoshka truncation, Cohere v3, Voyage, Mistral, Bedrock Titan v2, BGE/E5) so you can switch providers later without re-embedding.

`qdrant_api_key` is optional. Leave it empty or omit it for local or unauthenticated self-hosted Qdrant.

## Optional: add destinations and ignore rules

If you need separate stores for teams, clients, or environments, replace the top-level `qdrant_url` / `qdrant_api_key` fields with `destinations[]`. If some topics should never be persisted, add top-level `ignore[]` rules. You can merge this shape into either config above:

```jsonc
{
  "destinations": [
    {
      "name": "local-default",
      "description": "Default local memory.",
      "qdrant_url": "http://localhost:6333",
      "qdrant_api_key": "",
      "collection": "bikky-default",
      "default": true
    },
    {
      "name": "client-a",
      "description": "Client A memory.",
      "qdrant_url": "http://localhost:6333",
      "qdrant_api_key": "",
      "collection": "bikky-client-a",
      "match": {
        "cwd": ["^/Users/me/code/client-a"],
        "content": ["CLIENTA-\\d+"]
      }
    }
  ],
  "default_search_scope": "routed",
  "ignore": [
    {
      "name": "personal-topics",
      "description": "Never persist personal-topic memories.",
      "match": {
        "entity": ["^[Rr]esume$"],
        "content": ["\\b[Rr]esume\\b"]
      }
    }
  ]
}
```

See [multi-destination routing](https://github.com/bikky-dev/bikky/blob/main/docs/configuration.md#multi-destination-routing) and [ignore rules](https://github.com/bikky-dev/bikky/blob/main/docs/configuration.md#ignore-rules) for matching details.

## Alternative: OpenAI directly

```json
{
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1024,
    "api_key": "sk-..."
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4.1-mini",
    "api_key": "sk-..."
  }
}
```

Or set `OPENAI_API_KEY` in the environment instead of the config file.

## Check it

```bash
bikky status
```

If you started from a fresh install, run `bikky setup` after writing the config, then restart your editor so its MCP process reloads.

For Bedrock, custom base URLs, or model-specific dimensions, see the [full configuration guide](https://github.com/bikky-dev/bikky/blob/main/docs/configuration.md).
