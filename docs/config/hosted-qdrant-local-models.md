# Hosted Qdrant + local models

Use this path when you want memory shared across machines, but you still want embeddings and background curation to run through local Ollama.

## What you need

- A Qdrant Cloud cluster URL.
- A Qdrant API key.
- Ollama installed locally.
- The default embedding model pulled with `ollama pull qwen3-embedding:0.6b`.
- The default LLM model pulled with `ollama pull qwen2.5:7b`.

## Config

Save this as `~/.bikky/config.json`:

```json
{
  "qdrant_url": "https://your-cluster.cloud.qdrant.io:6333",
  "qdrant_api_key": "your-qdrant-api-key"
}
```

bikky will store memory in hosted Qdrant and keep model calls local through Ollama.

`qdrant_api_key` is optional only for unauthenticated self-hosted Qdrant. Qdrant Cloud usually requires it.

## Optional: add destinations and ignore rules

If you need separate stores for teams, clients, or environments, replace the top-level `qdrant_url` / `qdrant_api_key` fields with `destinations[]`. If some topics should never be persisted, add top-level `ignore[]` rules:

```jsonc
{
  "destinations": [
    {
      "name": "team",
      "description": "Default team memory.",
      "qdrant_url": "https://team.cloud.qdrant.io:6333",
      "qdrant_api_key": "...",
      "collection": "bikky-team",
      "default": true
    },
    {
      "name": "client-a",
      "description": "Client A memory.",
      "qdrant_url": "https://client-a.cloud.qdrant.io:6333",
      "qdrant_api_key": "...",
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
      "name": "do-not-store",
      "description": "Never persist memories explicitly marked do-not-store.",
      "match": {
        "entity": ["^do-not-store$"],
        "content": ["\\bdo-not-store\\b"]
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

After changing Qdrant settings, restart long-running processes:

```bash
bikky stop && bikky start
```

Then restart your editor so its MCP process reloads.
