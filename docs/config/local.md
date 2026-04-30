# Local and free config

Use this path first if you want a private, free setup: Qdrant runs on your machine, and Ollama handles local models.

Local model quality depends on the models you run. This setup is great for local-first use, but if you're evaluating bikky for a team or want the strongest extraction and embedding quality, use the [fully hosted config](fully-hosted.md).

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
