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

## Check it

```bash
bikky status
```

After changing Qdrant settings, restart long-running processes:

```bash
bikky stop && bikky start
```

Then restart your editor so its MCP process reloads.
