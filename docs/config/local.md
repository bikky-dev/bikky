# Local and free config

Use this path if you want a private, free setup: Qdrant runs on your machine, and Ollama handles local models.

This setup is best for private/free testing rather than long-term team use. Extraction, embedding, and curation performance depends on the local models and hardware you run.

## What you need

- Qdrant running locally, usually with Docker.
- Ollama installed locally.
- The default embedding model pulled with `ollama pull qwen3-embedding:0.6b`.
- The default LLM model pulled with `ollama pull qwen2.5:7b`.

## Config

Save this as `~/.bikky/config.json`:

```json
{
  "qdrant_url": "http://localhost:6333",
  "qdrant_api_key": ""
}
```

That's the whole config. bikky uses local Ollama defaults for embeddings and background curation.

`qdrant_api_key` is optional. Leave it empty or omit it for local or unauthenticated self-hosted Qdrant.

## Optional: add destinations and ignore rules

If you need separate stores for teams, clients, or environments, replace the top-level `qdrant_url` / `qdrant_api_key` fields with `destinations[]`. If some topics should never be persisted, add top-level `ignore[]` rules:

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

## Check it

```bash
bikky status
```

If you started from a fresh install, run `bikky setup` after writing the config, then restart your editor so its MCP process reloads.
