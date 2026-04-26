# Configuration

Config lives at `~/.bikky/config.json`. Resolution order: **defaults → config file → env vars** (highest wins).

## Qdrant (required)

| Setting | Env var | Default | Description |
|---------|---------|---------|-------------|
| `qdrant_url` | `QDRANT_URL` | *none — must be set* | Qdrant REST URL, e.g. `https://abc123.cloud.qdrant.io:6333` |
| `qdrant_api_key` | `QDRANT_API_KEY` | *none — must be set* | Qdrant API key from cluster dashboard |
| `collection` | `BIKKY_COLLECTION` | `bikky` | Collection name. Change only if running multiple instances |

## Ontology scope fields

Bikky's ontology includes optional scope payload fields such as `workspace_id`, `repo`, `branch`, `task_key`, `workstream_key`, and `episode_id`. These fields can be supplied through MCP calls or daemon-generated records where available; task 243 does not add workspace, redaction, or telemetry configuration sections.

## Embedding & LLM providers

Both `embedding.provider` and `llm.provider` accept exactly one of three values:

| Value | What it is | Auth needed | `base_url` used? |
|-------|-----------|-------------|-----------------|
| `ollama` | Local Ollama server | None | ✅ default `http://localhost:11434` |
| `openai` | OpenAI-compatible API | `api_key` or `OPENAI_API_KEY` | ✅ default `https://api.openai.com/v1` |
| `bedrock` | AWS Bedrock | AWS credentials (env or IAM role) | ❌ uses AWS SDK |

> **⚠️ Only these three values are valid.** Any other value is rejected at boot — the MCP server starts up but `requireReady` returns `setup_required` with a `setup_error` message until you fix the config.

### Embedding config

| Setting | Env var | Default |
|---------|---------|---------|
| `embedding.provider` | `EMBEDDING_PROVIDER` | `ollama` |
| `embedding.model` | `EMBEDDING_MODEL` | `qwen3-embedding:0.6b` |
| `embedding.dimensions` | `EMBEDDING_DIMENSIONS` | `1024` |
| `embedding.base_url` | `EMBEDDING_BASE_URL` | `http://localhost:11434` |
| `embedding.api_key` | `OPENAI_API_KEY` | — |

**Models by provider:**

| Provider | Recommended models | Dimensions |
|----------|-------------------|------------|
| `ollama` | `qwen3-embedding:0.6b`, `nomic-embed-text` | `1024`, `768` |
| `openai` | `text-embedding-3-small`, `text-embedding-3-large` | `1536`, `3072` |
| `bedrock` | `amazon.titan-embed-text-v2:0` | `1024` |

> **⚠️ `dimensions` must match your model's output.** Mismatched dimensions will cause Qdrant insert errors. If you change the model, update dimensions too.

### LLM config (used by daemon for extraction & consolidation)

| Setting | Env var | Default |
|---------|---------|---------|
| `llm.provider` | `LLM_PROVIDER` | `ollama` |
| `llm.model` | `LLM_MODEL` | `qwen2.5:7b` |
| `llm.base_url` | `LLM_BASE_URL` | `http://localhost:11434` |
| `llm.api_key` | `OPENAI_API_KEY` | — |
| `llm.bedrock_region` | `AWS_BEDROCK_REGION` | `us-east-1` |

**Models by provider:**

| Provider | Recommended models |
|----------|-------------------|
| `ollama` | `qwen2.5:7b`, `llama3.1:8b`, or any local model |
| `openai` | `gpt-4.1-mini`, `gpt-4.1` |
| `bedrock` | `anthropic.claude-3-5-haiku-20241022-v1:0` |

> `llm.bedrock_region` falls back to `AWS_REGION` if `AWS_BEDROCK_REGION` is not set.

### Provider auth quick-reference

| Provider | What to set |
|----------|------------|
| `ollama` | Nothing — just have Ollama running locally (`ollama serve`) |
| `openai` | `OPENAI_API_KEY` env var **or** `"api_key": "sk-..."` in the embedding/llm config block |
| `bedrock` | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` env vars, or an IAM instance role |

### Resilience knobs (timeouts & retries)

Both `embedding` and `llm` accept three optional fields that control how HTTP
calls to providers behave when things go wrong (network blips, 5xx, 429s).
These also work for the OpenAI-compatible `portkey` provider.

| Setting | Env var | Default |
|---------|---------|---------|
| `embedding.timeout_ms` | `BIKKY_EMBEDDING_TIMEOUT_MS` | `30000` |
| `embedding.retries` | `BIKKY_EMBEDDING_RETRIES` | `2` |
| `embedding.retry_base_delay_ms` | `BIKKY_EMBEDDING_RETRY_BASE_DELAY_MS` | `250` |
| `llm.timeout_ms` | `BIKKY_LLM_TIMEOUT_MS` | `30000` |
| `llm.retries` | `BIKKY_LLM_RETRIES` | `2` |
| `llm.retry_base_delay_ms` | `BIKKY_LLM_RETRY_BASE_DELAY_MS` | `250` |

Behaviour:

- `timeout_ms` is per-attempt (each retry gets its own clock).
- Retries use full-jitter exponential backoff capped at 5s, and honour
  `Retry-After` response headers (capped at 60s).
- Only `transient` (5xx, 408), `rate_limit` (429), and `timeout` errors are
  retried. `auth` (401/403) and `bad_request` (400/404/422) fail fast — they
  won't get better with retries.

### Setup errors and `requireReady`

If embedding init or Qdrant init fails at boot (bad provider name, missing
collection, unreachable host, etc.), the MCP server still starts. Tools that
need ready storage call `requireReady`, which returns a `setup_required`
payload that now includes a human-readable `setup_error` field:

```json
{
  "setup_required": true,
  "missing": ["qdrant-url"],
  "setup_error": "embedding init failed: [openai] (401): invalid api key"
}
```

`get_setup_status` exposes the same info for diagnostics.

## Copy-paste examples

**Ollama (default — zero config):**
```json
{
  "qdrant_url": "https://your-cluster.cloud.qdrant.io:6333",
  "qdrant_api_key": "your-key"
}
```

**OpenAI embeddings + LLM:**
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

**AWS Bedrock:**
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
    "model": "anthropic.claude-3-5-haiku-20241022-v1:0",
    "bedrock_region": "us-east-1"
  }
}
```

## Daemon settings

The daemon owns memory lifecycle work: it extracts ontology-v2 facts, writes lightweight session indexes, captures coherent episode summaries, and distills longer-lived patterns when consolidation is enabled.

| Setting | Default | Description |
|---------|---------|-------------|
| `daemon.tick_interval_sec` | `5` | Seconds between daemon loop ticks |
| `daemon.extract_every_sec` | `300` | Seconds between extraction runs |
| `daemon.extract_min_events` | `10` | Minimum session events before triggering extraction |
| `daemon.consolidation_enabled` | `true` | Auto-distill daemon-generated session summaries into patterns |
| `daemon.relation_inference_enabled` | `true` | Infer entity relationships via LLM |
| `daemon.staleness_threshold_days` | `30` | Days before a fact is flagged as stale |

## Logs

Bikky writes logs to `~/.bikky/logs/` (the same directory as the config file).

| File | Written by |
|------|-----------|
| `mcp.log` | The MCP server (`bikky mcp`) |
| `daemon.log` | The background daemon (`bikky daemon` / `bikky start`) |

Logs are **structured JSON lines** produced by [pino](https://github.com/pinojs/pino). Each line has at minimum `{level, time, name, msg}`; provider failures, telemetry events, and Qdrant operations attach extra fields (e.g. `provider`, `kind`, `status`). Files rotate in-process at 2MB, keeping 3 generations (`mcp.log` + `mcp.log.1` + `mcp.log.2`).

Pretty-print with [`pino-pretty`](https://github.com/pinojs/pino-pretty) when tailing:

```bash
tail -f ~/.bikky/logs/daemon.log | npx pino-pretty
```

Or grep structured fields with `jq`:

```bash
jq 'select(.level=="error")' ~/.bikky/logs/daemon.log
jq 'select(.provider=="openai" and .kind=="auth")' ~/.bikky/logs/mcp.log
```

Stdout/stderr are reserved for the MCP stdio transport — bikky never logs to the terminal from the MCP process.

## Memory ontology

New daemon captures use ontology v2:

```text
workspace -> domain -> repo/project/surface -> workstream -> episode -> memory objects
```

`domain` is an activity/knowledge profile, not a work/personal flag. The initial canonical domains are:

| Domain | Purpose |
|--------|---------|
| `software_engineering` | Default for coding-agent captures: repos, code, infrastructure, releases, incidents |
| `product_strategy` | Roadmap, positioning, experiments, customer insight, product decisions |
| `business_operations` | Company processes, vendors, compliance, obligations, recurring workflows |
| `research` | Source-backed investigation, hypotheses, contradictions, synthesis |
| `personal_productivity` | Individual goals, routines, preferences, projects, habits |

For `software_engineering`, canonical categories are `codebase`, `infrastructure`, `operations`, `decisions`, `product_domain`, `projects`, `people`, `preferences`, and `observations`.

`kind` stays small (`fact`, `summary`, `distilled`, `relation`, `telemetry`). More specific shape lives in `memory_subtype`, such as `codebase_map`, `architecture_decision`, `episode`, `workstream`, or `failure_mode`.

## Watcher settings

| Setting | Default | Description |
|---------|---------|-------------|
| `watchers.copilot.enabled` | `true` | Watch GitHub Copilot session logs |
| `watchers.copilot.path` | `~/.copilot/session-state` | Path to Copilot session directory |
| `watchers.claude.enabled` | `false` | Watch Claude Code project logs |
| `watchers.claude.path` | `~/.claude/projects` | Path to Claude Code projects directory |

## Agent integration templates

Run `bikky templates` to print all MCP client snippets, or `bikky templates cursor` / `bikky templates codex` for one target. See [docs/integrations.md](integrations.md).
