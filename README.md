<h1 align="center">bikky</h1>

<p align="center"><b>Persistent memory for AI coding agents — for teams, and for solo power users.</b></p>

bikky gives AI coding agents (GitHub Copilot, Claude Code, Cursor, and other MCP clients) long-term memory that persists across sessions, across tools, and across your whole team. Whether you're a team that wants every engineer's agent to start from the same knowledge base, or a solo power dev running a dozen agentic sessions a day, bikky captures what's learned *during* sessions so future sessions start smarter.

### Who it's for

- 👥 **Teams & software factories** — What one engineer's agent learns today, every agent on the team can recall tomorrow. Shared memory turns institutional knowledge into something queryable instead of tribal — onboarding accelerates, conventions stop drifting, and the same lesson never gets re-learned twice.
- 🧑‍💻 **Solo AI power devs** — You run multiple Cursor / Claude Code / Copilot sessions every day and you're tired of re-explaining the codebase, the conventions, and last week's decisions to each new agent. bikky remembers across every session and every tool.

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/bikky@latest/docs/diagrams/team-memory.svg" alt="Memory — facts flow from individual sessions into a self-curating knowledge store, shared across your team (or kept just for you)" width="720" />
</p>

<p align="center"><i>Knowledge flows from every session into a store that curates itself over time — deduplicating, distilling, and decaying stale facts — so every future session starts smarter. Share it across a team, or keep it solo.</i></p>

---

### The problem

The most valuable things you and your agents learn — why a config value exists, which deploy step matters, what broke last quarter, the convention you settled on yesterday — happen *during* sessions. And then they vanish when the session closes. Whether you're a team — where knowledge lives in heads, chat threads, and closed PRs, and every new engineer's agent has to learn it from scratch — or a solo power dev juggling dozens of agentic sessions a day across multiple tools that don't remember each other, it's the same wall. Hand-written docs drift the moment they're published.

### How bikky solves it

bikky gives your agent memory tools and runs a small background service after `bikky setup`. You keep working normally; bikky captures useful facts, organizes them, recalls them in future sessions, and keeps the store tidy over time.

- **Capture** — Facts are extracted automatically from session transcripts; no manual docs to write.
- **Classify** — Memories are grouped as **engineering**, **product**, **human**, or **system** so they stay easy to browse and filter.
- **Recall** — Every new session, yours or a teammate's, recalls from the same store via semantic search.
- **Curate** — bikky merges duplicates, fades stale facts, resolves contradictions, distills recurring patterns, and builds an entity graph over time.
- **Compound** — Session 50 is dramatically better than session 1 because memory accumulates.

Subtypes keep recall precise without making setup harder:

- **Engineering** — codebase maps, architecture decisions, infra topology, access patterns, operational procedures, troubleshooting gotchas, and conventions.
- **Product** — domain rules, product decisions, requirements, user workflows, roadmap items, success metrics, and market insights.
- **Human** — preferences, person profiles, ownership notes, working agreements, and activity events.
- **System** — session indexes, episodes, workstreams, and feedback signals.

---

## Quick start

This quick start uses **local Qdrant + hosted models**: Qdrant runs on your machine, while hosted embeddings and LLM calls provide strong extraction and recall quality without running local LLMs.

```bash
# 1. Pull and run Qdrant (vector store)
docker run -d --name qdrant -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant

# 2. Install bikky
npm install -g bikky
mkdir -p ~/.bikky
# Replace sk-... below with your hosted model API key.
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
# qdrant_api_key is optional; leave it empty or omit it for local Qdrant.
# Prefer env vars? Omit api_key above and set OPENAI_API_KEY instead.

# 3. Register bikky with your editor and start the background service
bikky setup            # writes MCP config for Copilot + Claude Code, then starts the daemon
```

Restart your editor. The memory tools appear automatically in supported MCP clients.

```bash
bikky status           # confirms Qdrant, embeddings, daemon, and UI health
```

That's it. You can keep Qdrant local forever, or move the vector store to Qdrant Cloud later.

For 100% local and account-free setup, use the [local and free config][local-config]. It is best for private testing rather than long-term team use, and extraction, embedding, and curation performance depends on the local models and hardware you run.

---

## Setup options

bikky supports four common setup shapes. Pick based on where you want Qdrant to run and where model calls should happen.

### What you need

| Component               | Required                       | Options                                                                                  |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| **Node.js**             | ≥ 20                           | `nvm install 20` or your package manager                                                 |
| **Vector store**        | Qdrant                         | Local Docker · [Qdrant Cloud](https://cloud.qdrant.io) · Self-hosted                     |
| **Embeddings**          | One provider                   | OpenAI · Ollama · Bedrock · Portkey                                                     |
| **LLM**                 | One provider                   | OpenAI · Ollama · Bedrock · Portkey                                                     |
| **Docker** *(optional)* | Only if you run Qdrant locally | Docker Desktop, OrbStack, colima, etc.                                                   |

Both `embedding.provider` and `llm.provider` accept the same values: `ollama`, `openai`, `bedrock`, or `portkey`.

> ⚠️ **Qdrant Cloud free tier does not include automatic backups.** Deleted collections cannot be recovered. If your memory data is valuable, use a paid Qdrant Cloud plan (which includes daily backups), run Qdrant locally with your own backup strategy, or periodically export snapshots via the [Qdrant snapshots API](https://qdrant.tech/documentation/concepts/snapshots/).

### Choose a setup

| Setup                            | Best for                                                       | Config                                                                    |
| -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Fully hosted**                 | Best performance and teams; managed vector storage and models  | [Fully hosted config][fully-hosted-config]                              |
| **Local Qdrant + hosted models** | Local vector storage with hosted extraction and embedding      | [Hosted models config][hosted-models-config]                            |
| **Local and free**               | Private/free testing; quality depends on local models          | [Local config guide][local-config]                                      |
| **Hosted Qdrant + local Ollama** | Shared vector storage while keeping model calls local          | [Hosted Qdrant + local models][hosted-qdrant-local-models-config]       |

### Configure

Pick the setup guide above for the copy-paste config. Config lives at `~/.bikky/config.json`, and you can also set `QDRANT_URL` and `QDRANT_API_KEY` as environment variables.

For hosted models, custom providers, multiple profiles, or advanced tuning, use the full configuration guide.

> 📖 **Full configuration guide:** [docs/configuration.md][configuration-guide]
>
> 🛠 Want to add a new embedding or LLM provider (Vertex, OpenRouter, etc.)? See **[CONTRIBUTING.md][contributing]** — it's a single-file change.

[fully-hosted-config]: https://cdn.jsdelivr.net/npm/bikky@latest/docs/config/fully-hosted.md
[hosted-models-config]: https://cdn.jsdelivr.net/npm/bikky@latest/docs/config/hosted-models.md
[local-config]: https://cdn.jsdelivr.net/npm/bikky@latest/docs/config/local.md
[hosted-qdrant-local-models-config]: https://cdn.jsdelivr.net/npm/bikky@latest/docs/config/hosted-qdrant-local-models.md
[configuration-guide]: https://cdn.jsdelivr.net/npm/bikky@latest/docs/configuration.md
[contributing]: https://cdn.jsdelivr.net/npm/bikky@latest/CONTRIBUTING.md

---

## Web UI

[`bikky-ui`](https://www.npmjs.com/package/bikky-ui) is a local dashboard for browsing and managing your team's memory — facts, entities, quality metrics, aggregate impact insights, and the relationship graph.

```bash
npx bikky-ui          # one-shot — no install needed
# or install globally
npm install -g bikky-ui
bikky-ui              # opens http://localhost:1422
```

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/bikky@latest/docs/screenshots/dashboard.png" alt="Dashboard — overview stats, category breakdown, recent facts" width="720" />
</p>
<p align="center"><i>Dashboard — memory stats, category breakdown, and recent facts at a glance</i></p>

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/bikky@latest/docs/screenshots/memory.png" alt="Memory browser — search, filter, and browse all stored facts" width="720" />
</p>
<p align="center"><i>Memory browser — search, filter by category/kind/source, and browse all stored facts</i></p>

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/bikky@latest/docs/screenshots/graph.png" alt="Entity graph — interactive visualization of entity relationships" width="720" />
</p>
<p align="center"><i>Entity graph — interactive visualization of how concepts, people, and services relate</i></p>

The UI reads from your existing `~/.bikky/config.json` (or `BIKKY_HOME/config.json`) — no extra configuration required.

## CLI

```bash
bikky mcp       # start MCP server (stdio) — used by editors
bikky setup     # install MCP configs for Copilot + Claude Code, then start the daemon
bikky start     # alias for setup
bikky stop      # stop the background daemon
bikky daemon    # run the daemon in the foreground
bikky status    # check memory system health
bikky ui        # launch the local web dashboard
bikky render    # render a prompt to JSON (for eval harnesses & debugging)
```

`bikky status` is the first thing to run when setup feels wrong. It checks the config, Qdrant, embeddings, background daemon, and local UI health, then tells you what needs attention. Use `bikky status --json` for automation.

## Multi-destination routing

Bikky can route memory operations to **different Qdrant accounts** based on caller context — useful when you want to keep work / personal / per-client memory in separate vector stores while sharing one bikky install and one editor MCP connection.

Configure `destinations[]` in `~/.bikky/config.json`. Each destination has its own credentials and an optional `match` block of regex patterns. The first destination whose pattern matches `cwd`, `entities`, `content`, or `metadata` wins; otherwise the destination flagged `default: true` (or the first one) is used.

```jsonc
{
  "embedding": { "provider": "openai", "model": "text-embedding-3-small", "dimensions": 1536 },
  "llm":       { "provider": "openai", "model": "gpt-4.1-mini" },
  "destinations": [
    {
      "name": "acme-client",
      "qdrant_url": "https://acme.cloud.qdrant.io:6333",
      "qdrant_api_key": "...",
      "collection": "bikky",
      "match": {
        "cwd":      ["^/Users/me/code/acme"],
        "entity":   ["^acme-"],
        "metadata": { "project": ["^acme$"] }
      }
    },
    {
      "name": "personal",
      "qdrant_url": "http://localhost:6333",
      "qdrant_api_key": "",
      "collection": "bikky",
      "default": true
    }
  ]
}
```

Tools accept an optional `destination: "name"` argument to override routing explicitly. All embeddings share one provider/dimensions config, so destinations must use the same vector size.

> **Migrating from `workspace_id` (pre-v0.4):** workspaces are removed in 0.4.0. Existing top-level `qdrant_url` / `qdrant_api_key` / `collection` are still honored as a single synthesized destination, so single-Qdrant setups need no changes. The `workspace_id` arg on memory tools is now a no-op.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
