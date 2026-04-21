# mem00

**Shared persistent memory for AI coding sessions.**

mem00 gives your AI coding assistants (GitHub Copilot, Claude Code) long-term memory that persists across sessions. Facts, decisions, architecture knowledge, and entity relationships are stored in a vector database and recalled automatically.

## How it works

```mermaid
graph TD
    A["🤖 Copilot / Claude Code"] <-->|MCP stdio| B["mem00 MCP Server"]
    C["📁 Session logs<br/>~/.copilot/"] -->|events.jsonl| D["mem00 Daemon<br/>(background)"]
    B -->|store / recall| E[("🔮 Qdrant Cloud<br/>vector DB")]
    D -->|embed + store| E
```

**MCP Server** — 12 memory tools your AI assistant can call directly:
- `memory_store` / `memory_recall` — store and search facts
- `memory_entity` / `memory_relations` — entity knowledge graph
- `memory_forget` / `memory_verify` — lifecycle management
- `memory_session_summary` / `memory_distill` — session consolidation
- `memory_heartbeat` — periodic reflection nudges

**Daemon** — background process that passively reads session logs:
- Watches `~/.copilot/session-state/` for new events
- Extracts facts via LLM from conversation transcripts
- Runs consolidation (distillation, contradiction detection)
- Infers entity relationships from co-occurring facts
- Scans for stale facts that need verification

## Quick start

```bash
# Install globally
npm install -g mem00

# Add to your editor's MCP config
mem00 install

# That's it — restart your editor and the memory tools appear
```

### Prerequisites

1. **Qdrant Cloud** (free tier: 1GB, no credit card)
   - Sign up at [cloud.qdrant.io](https://cloud.qdrant.io)
   - Create a cluster → copy the REST URL and API key

2. **Embedding provider** (one of):
   - **Ollama** (default, runs locally, free) — `brew install ollama && ollama pull qwen3-embedding:0.6b`
   - **OpenAI** — set `OPENAI_API_KEY` env var
   - **AWS Bedrock** — configure AWS credentials

### Setup

After installing, configure your Qdrant credentials. You can either:

**Option A** — Let your AI assistant do it:
```
> Call configure_credentials with my Qdrant URL and API key
```

**Option B** — Edit config directly:
```bash
cat > ~/.mem00/config.json << 'EOF'
{
  "qdrant_url": "https://your-cluster.cloud.qdrant.io:6333",
  "qdrant_api_key": "your-api-key-here"
}
EOF
```

**Option C** — Environment variables:
```bash
export QDRANT_URL="https://your-cluster.cloud.qdrant.io:6333"
export QDRANT_API_KEY="your-api-key-here"
```

## Configuration

Config lives at `~/.mem00/config.json`. Resolution order: **defaults → config file → env vars**.

### Qdrant

| Setting | Env var | Default | Description |
|---------|---------|---------|-------------|
| `qdrant_url` | `QDRANT_URL` | — | Qdrant Cloud REST URL |
| `qdrant_api_key` | `QDRANT_API_KEY` | — | Qdrant Cloud API key |
| `collection` | `MEM00_COLLECTION` | `mem00` | Qdrant collection name |

### Embedding

| Setting | Env var | Default | Options / Description |
|---------|---------|---------|----------------------|
| `embedding.provider` | `EMBEDDING_PROVIDER` | `ollama` | `ollama` · `openai` · `bedrock` |
| `embedding.model` | `EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | Any model supported by the provider. Ollama: `nomic-embed-text`, `qwen3-embedding:0.6b`; OpenAI: `text-embedding-3-small`, `text-embedding-3-large`; Bedrock: `amazon.titan-embed-text-v2:0` |
| `embedding.dimensions` | `EMBEDDING_DIMENSIONS` | `1024` | Must match the model's output. Common: `768`, `1024`, `1536`, `3072` |
| `embedding.base_url` | `EMBEDDING_BASE_URL` | `http://localhost:11434` | API endpoint. Only used by `ollama` and `openai` providers |
| `embedding.api_key` | `OPENAI_API_KEY` | — | API key for `openai` provider |

### LLM (extraction & consolidation)

| Setting | Env var | Default | Options / Description |
|---------|---------|---------|----------------------|
| `llm.provider` | `LLM_PROVIDER` | `ollama` | `ollama` · `openai` · `bedrock` |
| `llm.model` | `LLM_MODEL` | `qwen2.5:7b` | Any model supported by the provider. Ollama: any local model; OpenAI: `gpt-4.1-mini`, `gpt-4.1`; Bedrock: `anthropic.claude-3-5-haiku-20241022-v1:0` |
| `llm.base_url` | `LLM_BASE_URL` | `http://localhost:11434` | API endpoint. Only used by `ollama` and `openai` providers |
| `llm.api_key` | `OPENAI_API_KEY` | — | API key for `openai` provider |
| `llm.bedrock_region` | `AWS_BEDROCK_REGION` | `us-east-1` | AWS region for Bedrock. Falls back to `AWS_REGION` |

### Daemon

| Setting | Default | Options / Description |
|---------|---------|----------------------|
| `daemon.tick_interval_sec` | `5` | Seconds between daemon loop ticks |
| `daemon.extract_every_sec` | `300` | Seconds between extraction runs |
| `daemon.extract_min_events` | `5` | Min session events before triggering extraction |
| `daemon.consolidation_enabled` | `true` | `true` · `false` — auto-distill session summaries |
| `daemon.relation_inference_enabled` | `true` | `true` · `false` — infer entity relationships via LLM |
| `daemon.staleness_threshold_days` | `30` | Days before a fact is flagged as stale |

### Watchers

| Setting | Default | Options / Description |
|---------|---------|----------------------|
| `watchers.copilot.enabled` | `true` | `true` · `false` — watch Copilot session logs |
| `watchers.copilot.path` | `~/.copilot/session-state` | Path to Copilot session logs |
| `watchers.claude.enabled` | `false` | `true` · `false` — watch Claude Code projects |
| `watchers.claude.path` | `~/.claude/projects` | Path to Claude Code project logs |

### Provider authentication

| Provider | Required credentials |
|----------|---------------------|
| `ollama` | None (local) |
| `openai` | `OPENAI_API_KEY` env var or `embedding.api_key` / `llm.api_key` in config |
| `bedrock` | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (or IAM role), `AWS_BEDROCK_REGION` |

## CLI Commands

```bash
mem00 mcp       # Start MCP server (stdio) — used by editors
mem00 setup     # Interactive setup wizard
mem00 status    # Check memory system status
mem00 install   # Write MCP config for Copilot + Claude Code
```

## Memory architecture

### Deduplication

Two-layer dedup prevents bloat:

```mermaid
flowchart TD
    A[New fact] --> B{SHA-256<br/>content hash}
    B -->|exact match| C[Skip — duplicate]
    B -->|no match| D{Vector<br/>similarity}
    D -->|"> 0.92"| E["Reinforce existing<br/>(bump count)"]
    D -->|"> 0.80"| F[Store + flag<br/>as related]
    D -->|"< 0.80"| G[Store as new]
```

### Ranking formula
Facts are ranked using a combined score:
```
(vectorScore × 0.55 + freshness × 0.15 + reinforcement × 0.1 + importance × 0.1)
  × (0.7 + 0.3 × confidenceDecay)
```

### Entity knowledge graph

Facts mentioning multiple entities build an implicit graph:

```mermaid
graph LR
    subgraph "Entity Graph"
        S(saber) -->|owns| C(cortex)
        S -->|uses| Q(qdrant)
        C -->|depends-on| Q
        S -->|prefers| D(dark mode)
    end
```

The daemon periodically:
1. Scrolls all facts → builds entity co-occurrence map
2. For top pairs by shared-fact count → LLM infers relationship type
3. Stores typed edges (e.g., `saber --[owns]--> cortex`)

### Consolidation pipeline

```mermaid
flowchart LR
    A[Session<br/>summaries] --> B{5+ summaries?}
    B -->|yes| C[Auto-distill]
    C --> D[Distilled<br/>patterns]
    E[All facts] --> F[Contradiction<br/>detection]
    F --> G[Flagged for<br/>review]
    E --> H[Staleness<br/>scan]
    H --> I["Stale facts<br/>(30+ days)"]
```

- **Auto-distill** — merges 5+ session summaries into distilled patterns
- **Contradiction detection** — flags conflicting facts for review
- **Category rebalancing** — consolidates oversized categories
- **Staleness scanning** — surfaces facts that haven't been verified in 30+ days

## License

AGPL-3.0 — see [LICENSE](LICENSE).
