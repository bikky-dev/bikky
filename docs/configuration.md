# Configuration

bikky is designed to keep setup small. For the best first-time experience, run Qdrant locally and use hosted models for embeddings and extraction quality. For private, free, account-free testing, you can use local Ollama models instead.

```bash
mkdir -p ~/.bikky
cat > ~/.bikky/config.json <<'JSON'
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
JSON
bikky status
```

Config lives at `~/.bikky/config.json`, or at `BIKKY_HOME/config.json` when `BIKKY_HOME` is set. Environment variables override the config file.

## Common setups

If you know which path you want, start with the focused guide:

| Scenario | Guide |
|---|---|
| Recommended first-time | [Hosted models config](config/hosted-models.md) |
| Local and free | [Local config guide](config/local.md) |
| Hosted Qdrant + local models | [Hosted Qdrant + local models](config/hosted-qdrant-local-models.md) |
| Fully hosted | [Fully hosted config](config/fully-hosted.md) |

### Recommended first-time

Use this when you want the best first impression: Qdrant runs locally, while hosted embeddings and LLM calls provide stronger extraction and recall quality than small local models.

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

`qdrant_api_key` is optional. Leave it empty or omit it for local or unauthenticated self-hosted Qdrant. Prefer env vars for hosted model auth? Omit `api_key` above and set `OPENAI_API_KEY` instead.

### Local and free

Use this for private, free, account-free testing. Qdrant runs locally and Ollama provides the default embedding + LLM models.

Local model quality depends on the models you run. For the strongest extraction and embedding quality while evaluating bikky, use the [hosted models config](config/hosted-models.md).

```json
{
  "qdrant_url": "http://localhost:6333",
  "qdrant_api_key": ""
}
```

`qdrant_api_key` is optional. Leave it empty or omit it for local or unauthenticated self-hosted Qdrant.

### Hosted Qdrant, local models

Use this when you want the memory database shared across machines, but still want embeddings and LLM calls to stay local.

```json
{
  "qdrant_url": "https://your-cluster.cloud.qdrant.io:6333",
  "qdrant_api_key": "your-key"
}
```

`qdrant_api_key` is optional only for unauthenticated self-hosted Qdrant. Qdrant Cloud usually requires it.

### Hosted Qdrant and hosted models

Use this when you want the whole stack managed. This example uses OpenAI-compatible hosted models:

```json
{
  "qdrant_url": "https://your-cluster.cloud.qdrant.io:6333",
  "qdrant_api_key": "your-key",
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

After changing Qdrant or provider settings, restart long-running processes:

```bash
bikky stop && bikky start
```

Then restart your editor so its MCP server process reloads the config.

## Environment variables

Use env vars when you do not want to write credentials to the config file:

```bash
export QDRANT_URL="http://localhost:6333"
export QDRANT_API_KEY="..."  # only needed for Qdrant Cloud or authenticated self-hosted Qdrant
```

Useful basics:

| Env var | Config field | Notes |
|---|---|---|
| `QDRANT_URL` | `qdrant_url` | Required unless set in config |
| `QDRANT_API_KEY` | `qdrant_api_key` | Optional for local/unauthenticated Qdrant; usually needed for Qdrant Cloud |
| `BIKKY_HOME` | — | Moves the config/log/state directory from `~/.bikky` |

## Provider options

You can keep the defaults unless you want hosted models.

| Provider | Best for | Auth |
|---|---|---|
| `ollama` | Local and free defaults | None |
| `openai` | Simple hosted models | `OPENAI_API_KEY` or `api_key` |
| `bedrock` | AWS-managed models | AWS credentials or IAM role |
| `portkey` | Gateway/routing over other providers | Portkey API key |

<details>
<summary>Advanced: full setting reference</summary>

### Qdrant

| Setting | Env var | Default | Description |
|---|---|---|---|
| `qdrant_url` | `QDRANT_URL` | none | Qdrant REST URL |
| `qdrant_api_key` | `QDRANT_API_KEY` | none | Optional for local/unauthenticated Qdrant; required for Qdrant Cloud/authenticated self-hosted Qdrant |
| `collection` | `BIKKY_COLLECTION` | `bikky` | Collection name |

### Embeddings

| Setting | Env var | Default |
|---|---|---|
| `embedding.provider` | `EMBEDDING_PROVIDER` | `ollama` |
| `embedding.model` | `EMBEDDING_MODEL` | `qwen3-embedding:0.6b` |
| `embedding.dimensions` | `EMBEDDING_DIMENSIONS` | `1024` |
| `embedding.base_url` | `EMBEDDING_BASE_URL` | `http://localhost:11434` |
| `embedding.api_key` | `OPENAI_API_KEY` | — |

Common model dimensions:

| Provider | Model | Dimensions |
|---|---|---|
| `ollama` | `qwen3-embedding:0.6b` | `1024` |
| `ollama` | `nomic-embed-text` | `768` |
| `openai` | `text-embedding-3-small` | `1536` |
| `openai` | `text-embedding-3-large` | `3072` |
| `bedrock` | `amazon.titan-embed-text-v2:0` | `1024` |

If you change the embedding model, make sure `embedding.dimensions` matches the model output.

### LLM

The LLM is used by background maintenance features. Ollama is the default.

| Setting | Env var | Default |
|---|---|---|
| `llm.provider` | `LLM_PROVIDER` | `ollama` |
| `llm.model` | `LLM_MODEL` | `qwen2.5:7b` |
| `llm.base_url` | `LLM_BASE_URL` | `http://localhost:11434` |
| `llm.api_key` | `OPENAI_API_KEY` | — |
| `llm.extra.region` | `AWS_BEDROCK_REGION` / `AWS_REGION` | `us-east-1` |

### Timeouts and retries

| Setting | Env var | Default |
|---|---|---|
| `embedding.timeout_ms` | `BIKKY_EMBEDDING_TIMEOUT_MS` | `30000` |
| `embedding.retries` | `BIKKY_EMBEDDING_RETRIES` | `2` |
| `embedding.retry_base_delay_ms` | `BIKKY_EMBEDDING_RETRY_BASE_DELAY_MS` | `250` |
| `llm.timeout_ms` | `BIKKY_LLM_TIMEOUT_MS` | `30000` |
| `llm.retries` | `BIKKY_LLM_RETRIES` | `2` |
| `llm.retry_base_delay_ms` | `BIKKY_LLM_RETRY_BASE_DELAY_MS` | `250` |

Retries use jittered exponential backoff for transient errors, rate limits, and timeouts. Authentication and bad-request errors fail fast.

</details>

<details>
<summary>Advanced: Portkey and Bedrock examples</summary>

### Portkey gateway

```json
{
  "qdrant_url": "https://your-cluster.cloud.qdrant.io:6333",
  "qdrant_api_key": "your-key",
  "embedding": {
    "provider": "portkey",
    "model": "@openai/text-embedding-3-small",
    "dimensions": 1536,
    "api_key": "pk-..."
  },
  "llm": {
    "provider": "portkey",
    "model": "@openai/gpt-4o-mini",
    "api_key": "pk-...",
    "extra": { "virtual_key": "openai-prod" }
  }
}
```

### AWS Bedrock

```json
{
  "qdrant_url": "https://your-cluster.cloud.qdrant.io:6333",
  "qdrant_api_key": "your-key",
  "embedding": {
    "provider": "bedrock",
    "model": "amazon.titan-embed-text-v2:0",
    "dimensions": 1024
  },
  "llm": {
    "provider": "bedrock",
    "model": "us.anthropic.claude-sonnet-4-20250514",
    "extra": { "region": "us-east-1" }
  }
}
```

Bedrock reads `embedding.extra.region` and `llm.extra.region`. `AWS_BEDROCK_REGION` populates both, falling back to `AWS_REGION`; `aws_profile` or `AWS_PROFILE` selects the shared AWS profile when you are not using direct env credentials.

</details>

<details>
<summary>Advanced: workspace and metadata scoping</summary>

Most users do not need to manage scopes manually. bikky can store optional metadata such as `workspace_id`, `repo`, `branch`, `task_key`, `workstream_key`, and `episode_id` when an agent or daemon has that context.

If you do need workspace isolation, scope resolution is:

1. Explicit `workspace_id` on a tool call
2. `BIKKY_WORKSPACE`
3. `default_workspace` in config
4. Unscoped

Example:

```json
{
  "qdrant_url": "http://localhost:6333",
  "qdrant_api_key": "",
  "default_workspace": "team"
}
```

`qdrant_api_key` is optional. Leave it empty or omit it for local or unauthenticated self-hosted Qdrant.

The literal workspace name `"default"` also reads legacy facts that do not have a `workspace_id` payload. Other named workspaces are strict.

</details>

<details>
<summary>Advanced: daemon, watchers, and logs</summary>

You normally do not need to tune these. `bikky setup` starts the daemon and registers supported MCP clients.

### Daemon settings

| Setting | Default | Description |
|---|---|---|
| `daemon.tick_interval_sec` | `5` | Seconds between daemon loop ticks |
| `daemon.extract_every_sec` | `300` | Seconds between extraction runs |
| `daemon.extract_min_events` | `10` | Minimum session events before triggering extraction |
| `daemon.consolidation_enabled` | `true` | Consolidate session summaries into durable patterns |
| `daemon.relation_inference_enabled` | `true` | Infer entity relationships |
| `daemon.entity_typing_enabled` | `true` | Classify entities for UI/graph filtering |
| `daemon.staleness_threshold_days` | `30` | Days before a fact is flagged as stale |

### Watcher settings

| Setting | Default | Description |
|---|---|---|
| `watchers.copilot.enabled` | `true` | Watch GitHub Copilot session logs |
| `watchers.copilot.path` | `~/.copilot/session-state` | Path to Copilot session directory |
| `watchers.claude.enabled` | `true` | Watch Claude Code project logs |
| `watchers.claude.path` | `~/.claude/projects` | Path to Claude Code projects directory |

### Logs

bikky writes logs to `~/.bikky/logs/`:

| File | Written by |
|---|---|
| `mcp.log` | MCP server |
| `daemon.log` | Background daemon |
| `llm.jsonl` | LLM telemetry |

Pretty-print logs with:

```bash
tail -f ~/.bikky/logs/daemon.log | npx pino-pretty
```

</details>

## Troubleshooting

Run:

```bash
bikky status
```

`bikky status` is read-only. It checks the config, Qdrant connection, collection readiness, embedding connectivity, daemon state, and local UI health. If something is missing or misconfigured, it exits non-zero and prints the next fix to make.
