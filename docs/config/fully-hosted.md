# Fully hosted config

Best for performance and teams. This setup uses Qdrant Cloud for managed vector storage and OpenAI-compatible hosted models for extraction, curation, and recall.

## What you need

- A Qdrant Cloud cluster URL.
- A Qdrant API key.
- An OpenAI API key, or another hosted provider configured in the full configuration guide.

For both `embedding.provider` and `llm.provider`, possible values are `openai`, `bedrock`, or `portkey` for hosted models. `ollama` is also supported when you want local model calls.

## Config

Save this as `~/.bikky/config.json`:

```json
{
  "qdrant_url": "https://your-cluster.cloud.qdrant.io:6333",
  "qdrant_api_key": "your-qdrant-api-key",
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536,
    "api_key": "sk-..."
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4.1-mini",
    "api_key": "sk-..."
  }
}
```

`qdrant_api_key` is optional only for unauthenticated self-hosted Qdrant. Qdrant Cloud usually requires it.

Prefer not to store hosted model keys in the config file? Omit `api_key` above and set:

```bash
export OPENAI_API_KEY="sk-..."
```

## Check it

```bash
bikky status
```

After changing Qdrant or provider settings, restart long-running processes:

```bash
bikky stop && bikky start
```

Then restart your editor so its MCP process reloads.

For Bedrock, Portkey, custom base URLs, or model-specific dimensions, see the [full configuration guide](../configuration.md).
