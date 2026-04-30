# Hosted models config

Use this path for the best first-time experience: Qdrant runs locally, while hosted embeddings and LLM calls give bikky stronger extraction, curation, and recall quality out of the box.

## What you need

- Qdrant running locally, usually with Docker.
- An OpenAI API key, or another hosted provider configured in the full configuration guide.

## Config

Save this as `~/.bikky/config.json`:

```json
{
  "qdrant_url": "http://localhost:6333",
  "qdrant_api_key": "",
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

`qdrant_api_key` is optional. Leave it empty or omit it for local or unauthenticated self-hosted Qdrant.

Prefer not to store hosted model keys in the config file? Omit `api_key` above and set:

```bash
export OPENAI_API_KEY="sk-..."
```

## Check it

```bash
bikky status
```

If you started from a fresh install, run `bikky setup` after writing the config, then restart your editor so its MCP process reloads.

For Bedrock, Portkey, custom base URLs, or model-specific dimensions, see the [full configuration guide](../configuration.md).
