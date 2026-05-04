# Configuration

bikky is designed to keep setup small. The example below keeps Qdrant local and uses hosted models; the focused guides list the other common setup shapes.

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

| Setup                         | Best for                                                     | Guide                                                                    |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Fully hosted                  | Best performance and teams; managed vector storage and models | [Fully hosted config](config/fully-hosted.md)                            |
| Local Qdrant + hosted models  | Local vector storage with hosted extraction and embedding    | [Hosted models config](config/hosted-models.md)                          |
| Local and free                | Local evaluation; quality depends on local models            | [Local config guide](config/local.md)                                    |
| Hosted Qdrant + local models  | Shared vector storage while keeping model calls local        | [Hosted Qdrant + local models](config/hosted-qdrant-local-models.md)     |

### Fully hosted

Best for performance and teams. Qdrant Cloud stores vectors, and hosted embeddings + LLM calls handle extraction, curation, and recall.

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

### Local Qdrant + hosted models

Best for local vector storage with hosted extraction and embedding quality.

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

Use this for local, free, account-free evaluation. Qdrant runs locally and Ollama provides the default embedding + LLM models.

This setup is usually not the best long-term choice for teams. Extraction, embedding, and curation performance depends on the local models and hardware you run.

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

| Env var          | Config field     | Notes                                                                       |
| ---------------- | ---------------- | --------------------------------------------------------------------------- |
| `QDRANT_URL`     | `qdrant_url`     | Required unless set in config                                               |
| `QDRANT_API_KEY` | `qdrant_api_key` | Optional for local/unauthenticated Qdrant; usually needed for Qdrant Cloud  |
| `BIKKY_HOME`     | —                | Moves the config/log/state directory from `~/.bikky`                        |

## Provider options

Use these exact values in `embedding.provider` and `llm.provider`. Both fields accept the same provider values, and you can choose them independently.

| Provider value | Works for embeddings | Works for LLM | Best for                             | Auth                              |
| -------------- | -------------------- | ------------- | ------------------------------------ | --------------------------------- |
| `ollama`       | Yes                  | Yes           | Local and free defaults              | None                              |
| `openai`       | Yes                  | Yes           | Simple hosted models                 | `OPENAI_API_KEY` or `api_key`     |
| `bedrock`      | Yes                  | Yes           | AWS-managed models                   | AWS credentials or IAM role       |
| `portkey`      | Yes                  | Yes           | Gateway/routing over other providers | Portkey API key                   |

## Advanced configuration

These sections are optional references for custom providers, tuning, scoping, and daemon internals.

### Full setting reference

#### Qdrant

| Setting          | Env var            | Default | Notes                          |
| ---------------- | ------------------ | ------- | ------------------------------ |
| `qdrant_url`     | `QDRANT_URL`       | none    | Qdrant REST URL                |
| `qdrant_api_key` | `QDRANT_API_KEY`   | none    | API key for authenticated Qdrant |
| `collection`     | `BIKKY_COLLECTION` | `bikky` | Collection name                |

`qdrant_api_key` is optional for local or unauthenticated self-hosted Qdrant. Qdrant Cloud usually requires it.

#### Embeddings

| Setting                | Env var                | Default                  | Notes                                           |
| ---------------------- | ---------------------- | ------------------------ | ----------------------------------------------- |
| `embedding.provider`   | `EMBEDDING_PROVIDER`   | `ollama`                 | One of `ollama`, `openai`, `bedrock`, `portkey` |
| `embedding.model`      | `EMBEDDING_MODEL`      | `qwen3-embedding:0.6b`   | Embedding model name                            |
| `embedding.dimensions` | `EMBEDDING_DIMENSIONS` | `1024`                   | Must match the selected model output            |
| `embedding.base_url`   | `EMBEDDING_BASE_URL`   | `http://localhost:11434` | Used by local or OpenAI-compatible providers    |
| `embedding.api_key`    | `OPENAI_API_KEY`       | —                        | Provider API key; can also be set in config     |

Common model dimensions:

| Provider  | Model                            | Dimensions |
| --------- | -------------------------------- | ---------- |
| `ollama`  | `qwen3-embedding:0.6b`           | `1024`     |
| `ollama`  | `nomic-embed-text`               | `768`      |
| `openai`  | `text-embedding-3-small`         | `1536`     |
| `openai`  | `text-embedding-3-large`         | `3072`     |
| `bedrock` | `amazon.titan-embed-text-v2:0`   | `1024`     |

If you change the embedding model, make sure `embedding.dimensions` matches the model output.

#### LLM

The LLM is used by background maintenance features. Ollama is the default.

| Setting            | Env var                              | Default                  | Notes                                        |
| ------------------ | ------------------------------------ | ------------------------ | -------------------------------------------- |
| `llm.provider`     | `LLM_PROVIDER`                       | `ollama`                 | One of `ollama`, `openai`, `bedrock`, `portkey` |
| `llm.model`        | `LLM_MODEL`                          | `qwen2.5:7b`             | LLM model name                               |
| `llm.base_url`     | `LLM_BASE_URL`                       | `http://localhost:11434` | Used by local or OpenAI-compatible providers |
| `llm.api_key`      | `OPENAI_API_KEY`                     | —                        | Provider API key; can also be set in config  |
| `llm.extra.region` | `AWS_BEDROCK_REGION` / `AWS_REGION`  | `us-east-1`              | AWS Bedrock region                           |

#### Timeouts and retries

| Setting                         | Env var                                  | Default |
| ------------------------------- | ---------------------------------------- | ------- |
| `embedding.timeout_ms`          | `BIKKY_EMBEDDING_TIMEOUT_MS`             | `30000` |
| `embedding.retries`             | `BIKKY_EMBEDDING_RETRIES`                | `2`     |
| `embedding.retry_base_delay_ms` | `BIKKY_EMBEDDING_RETRY_BASE_DELAY_MS`    | `250`   |
| `llm.timeout_ms`                | `BIKKY_LLM_TIMEOUT_MS`                   | `30000` |
| `llm.retries`                   | `BIKKY_LLM_RETRIES`                      | `2`     |
| `llm.retry_base_delay_ms`       | `BIKKY_LLM_RETRY_BASE_DELAY_MS`          | `250`   |

Retries use jittered exponential backoff for transient errors, rate limits, and timeouts. Authentication and bad-request errors fail fast.

### Portkey and Bedrock examples

#### Portkey gateway

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

#### AWS Bedrock

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

### Multi-destination routing

Most users only need one Qdrant destination. Use `destinations[]` when you want one bikky install and one editor MCP connection to read or write separate memory stores for different teams, clients, or environments.

Each destination has its own Qdrant credentials and collection. Add `description` when you have more than one destination; MCP tools expose those descriptions so LLM clients can pick the right search scope.

Writes still target one destination. A destination can include a `match` block with JavaScript `RegExp` strings for `cwd`, `entity`, `content`, or `metadata`. Destinations are evaluated in array order; the first destination with any matching pattern wins. If no pattern matches, bikky uses the destination marked `default: true`, or the first destination.

Read tools (`memory_recall`, `memory_entity`, and `memory_relations`) can search one destination, the routed destination, or multiple destinations. Configure `default_search_scope` to control the default read behavior:

- `"routed"` — search the single destination selected by routing rules. This is the default and preserves older behavior.
- `"all"` — search every configured destination and merge/rerank the results.
- `"client-a"` — search one destination by name.
- `["client-a", "platform"]` — search a fixed list of destinations.

MCP clients can override this per call with `search_scope`. The value accepts `"routed"`, `"all"`, a destination name, a configured named scope, a comma-separated destination list, or an array of destination names. Do not combine `destination` and `search_scope`; keep `destination` for exact single-destination overrides, especially on write tools.

```jsonc
{
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4.1-mini"
  },
  "default_search_scope": "routed",
  "destinations": [
    {
      "name": "client-a",
      "description": "Client A project memory. Use for Client A code, tickets, and operating context.",
      "qdrant_url": "https://client-a.cloud.qdrant.io:6333",
      "qdrant_api_key": "...",
      "collection": "bikky-client-a",
      "match": {
        "cwd": ["^/Users/me/code/client-a"],
        "entity": ["^client-a-"],
        "content": ["client-a", "CLIENTA-\\d+"],
        "metadata": { "project": ["^client-a$"] }
      }
    },
    {
      "name": "research-cloud",
      "description": "Research and experiment memory that may be useful across projects.",
      "qdrant_url": "https://research.cloud.qdrant.io:6333",
      "qdrant_api_key": "...",
      "collection": "bikky-research",
      "match": {
        "content": ["[Rr]esearch[- ][Ll]ab"]
      }
    },
    {
      "name": "platform",
      "description": "Default platform engineering memory.",
      "qdrant_url": "http://localhost:6333",
      "qdrant_api_key": "",
      "collection": "bikky-platform",
      "default": true
    }
  ],
  "search_scopes": [
    {
      "name": "project-wide",
      "description": "Search Client A and shared platform memory together when the answer may depend on both.",
      "destinations": ["client-a", "platform"]
    }
  ]
}
```

Matching details:

- `match.cwd`, `match.entity`, and `match.content` are lists of JavaScript `RegExp` strings.
- `match.metadata` maps metadata keys to lists of JavaScript `RegExp` strings matched against that key's value.
- Matching uses OR logic across fields and within each list; any matching pattern selects the destination.
- Put the most specific destinations first because first match wins.
- JavaScript regex flags are not supported in config strings. Use character classes like `[Bb]ikky` for case-insensitive matching.
- Tool calls can override routing with an explicit destination name, for example `memory_store({ ..., destination: "client-a" })`.
- Read/search tools also accept `search_scope`; call `memory_search_scopes` or `get_setup_status` to see available scopes and descriptions.
- All destinations share one embedding provider, so every destination collection must use the same vector dimensions.

Migrating from `workspace_id` pre-v0.4:

- Existing top-level `qdrant_url`, `qdrant_api_key`, and `collection` configs still work as a single synthesized destination.
- The `workspace_id` argument on memory tools is a no-op for compatibility.
- Replace `default_workspace` scoping with named destinations when you need isolation.

### Daemon, watchers, and logs

You normally do not need to tune these. `bikky setup` starts the daemon and registers supported MCP clients.

#### Daemon settings

| Setting                              | Default | Description                                      |
| ------------------------------------ | ------- | ------------------------------------------------ |
| `daemon.tick_interval_sec`           | `5`     | Seconds between daemon loop ticks                |
| `daemon.extract_every_sec`           | `300`   | Seconds between extraction runs                  |
| `daemon.extract_min_events`          | `10`    | Minimum events before extraction                 |
| `daemon.consolidation_enabled`       | `true`  | Consolidate summaries into durable patterns      |
| `daemon.relation_inference_enabled`  | `true`  | Infer entity relationships                       |
| `daemon.entity_typing_enabled`       | `true`  | Classify entities for UI/graph filtering         |
| `daemon.staleness_threshold_days`    | `30`    | Days before a fact is flagged as stale           |

#### Watcher settings

| Setting                    | Default                    | Description                       |
| -------------------------- | -------------------------- | --------------------------------- |
| `watchers.copilot.enabled` | `true`                     | Watch GitHub Copilot session logs |
| `watchers.copilot.path`    | `~/.copilot/session-state` | Path to Copilot session directory |
| `watchers.claude.enabled`  | `true`                     | Watch Claude Code project logs    |
| `watchers.claude.path`     | `~/.claude/projects`       | Path to Claude Code projects      |

Claude Code ingestion reads top-level `*.jsonl` transcripts inside each project directory under `watchers.claude.path`. It captures user/assistant text and skips tool calls, tool results, attachments, file snapshots, permission records, and thinking blocks.

#### Logs

bikky writes logs to `~/.bikky/logs/`:

| File         | Written by        |
| ------------ | ----------------- |
| `mcp.log`    | MCP server        |
| `daemon.log` | Background daemon |
| `llm.jsonl`  | LLM telemetry     |

Pretty-print logs with:

```bash
tail -f ~/.bikky/logs/daemon.log | npx pino-pretty
```

## Troubleshooting

Run:

```bash
bikky status
```

`bikky status` is read-only. It checks the config, Qdrant connection, collection readiness, embedding connectivity, daemon state, and local UI health. If something is missing or misconfigured, it exits non-zero and prints the next fix to make.
