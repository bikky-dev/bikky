# Local and free config

Use this path first if you want the simplest setup: Qdrant runs on your machine, and Ollama handles local models.

## What you need

- Qdrant running locally, usually with Docker.
- Ollama installed locally.
- The default embedding model pulled with `ollama pull qwen3-embedding:0.6b`.

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

## Check it

```bash
bikky status
```

If you started from a fresh install, run `bikky setup` after writing the config, then restart your editor so its MCP process reloads.
