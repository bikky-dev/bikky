# Fully hosted config

Use this path when you want managed vector storage and hosted models. This example uses Qdrant Cloud and OpenAI-compatible hosted models.

## What you need

- A Qdrant Cloud cluster URL.
- A Qdrant API key.
- An OpenAI API key, or another hosted provider configured in the full configuration guide.

## Config

Save this as `~/.bikky/config.json`:

```json
{
  "qdrant_url": "https://your-cluster.cloud.qdrant.io:6333",
  "qdrant_api_key": "your-qdrant-api-key",
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4.1-mini"
  }
}
```

Set the API key as an environment variable so it does not have to live in the config file:

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

