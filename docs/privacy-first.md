# Privacy-first quickstart

Use this setup when you want to evaluate bikky with local storage and local model calls before opting into any hosted provider.

## What this protects

This guide keeps memory vectors, extracted facts, and transcript extraction model calls on your machine:

- Qdrant runs locally in Docker.
- Embeddings and LLM extraction use local Ollama models.
- Automatic transcript capture can be disabled entirely.

Package installation still talks to npm, Docker pulls images from its registry, and Ollama pulls models from its registry. After those dependencies are installed, bikky does not send memory data to a hosted vector store or hosted model provider unless you configure one.

## 1. Start local dependencies

```bash
docker run -d --name qdrant -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant

ollama pull qwen3-embedding:0.6b
ollama pull qwen2.5:7b
```

## 2. Install bikky

```bash
npm install -g bikky
```

The package has a best-effort postinstall setup hook for convenience. For the most explicit first run, write your config first and then run `bikky setup` yourself.

## 3. Choose your capture mode

### Recall-only mode

Use this mode when you want MCP memory tools available but do not want bikky to read coding-agent transcripts in the background.

```bash
mkdir -p ~/.bikky
cat > ~/.bikky/config.json <<'JSON'
{
  "qdrant_url": "http://localhost:6333",
  "qdrant_api_key": "",
  "embedding": {
    "provider": "ollama",
    "model": "qwen3-embedding:0.6b",
    "dimensions": 1024,
    "base_url": "http://localhost:11434"
  },
  "llm": {
    "provider": "ollama",
    "model": "qwen2.5:7b",
    "base_url": "http://localhost:11434"
  },
  "daemon": {
    "extract_every_sec": 0
  },
  "watchers": {
    "copilot": { "enabled": false },
    "claude": { "enabled": false }
  }
}
JSON
```

### Local-only capture mode

Use this mode when you want automatic memory extraction from supported local coding-agent transcripts, but still want extraction model calls to stay local.

```json
{
  "qdrant_url": "http://localhost:6333",
  "qdrant_api_key": "",
  "embedding": {
    "provider": "ollama",
    "model": "qwen3-embedding:0.6b",
    "dimensions": 1024,
    "base_url": "http://localhost:11434"
  },
  "llm": {
    "provider": "ollama",
    "model": "qwen2.5:7b",
    "base_url": "http://localhost:11434"
  }
}
```

In this mode, the daemon reads supported transcript locations on your machine:

- GitHub Copilot session state: `~/.copilot/session-state`
- Claude Code project transcripts: `~/.claude/projects`

It sends extracted transcript snippets only to the configured local Ollama endpoint. If you switch `embedding.provider`, `llm.provider`, or Qdrant to hosted services later, the relevant facts, vectors, or model inputs will leave your machine for those configured providers.

## 4. Start and verify

```bash
bikky setup
bikky status
```

If you change providers, watcher settings, or `daemon.extract_every_sec`, restart long-running processes:

```bash
bikky stop && bikky start
```

Restart your editor after setup so its MCP server process reloads the config.

## What can leave your machine

| Configuration choice | What leaves your machine |
| -------------------- | ------------------------ |
| Local Qdrant + Ollama | No memory payloads, vectors, or extraction model inputs leave through bikky. |
| Qdrant Cloud or hosted Qdrant | Stored facts, metadata, and vectors are sent to that Qdrant endpoint. |
| Hosted embedding provider | Text sent for embedding and resulting vectors are handled by that provider. |
| Hosted LLM provider | Transcript snippets selected for extraction, curation, or distillation are sent to that provider. |
| MCP client integration | Tool calls and tool results are visible to the MCP client that invoked them. |

## Turning capture off later

To stop background transcript extraction while keeping search/recall tools available:

```json
{
  "daemon": {
    "extract_every_sec": 0
  },
  "watchers": {
    "copilot": { "enabled": false },
    "claude": { "enabled": false }
  }
}
```

Then restart bikky:

```bash
bikky stop && bikky start
```
