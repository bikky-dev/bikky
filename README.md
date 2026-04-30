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

The recommended first-time setup is **local Qdrant + hosted models**: Qdrant runs on your machine, while hosted embeddings and LLM calls give you the best extraction and recall quality out of the box.

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

Prefer 100% local and account-free? Use the [local and free config](docs/config/local.md). Local Ollama models are great for private testing, but extraction and embedding quality depends on the models you run.

---

## Setup options

Start with the recommended first-time path for the best extraction and embedding quality. Choose the local path when privacy, offline use, or zero hosted-model cost matters most.

### What you need

| Component               | Required                       | Options                                                                                  |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| **Node.js**             | ≥ 20                           | `nvm install 20` or your package manager                                                 |
| **Vector store**        | Qdrant                         | Local Docker (recommended first) · [Qdrant Cloud](https://cloud.qdrant.io) · Self-hosted |
| **Embeddings**          | One provider                   | OpenAI · Ollama · Bedrock · Portkey                                                     |
| **LLM**                 | One provider                   | OpenAI · Ollama · Bedrock · Portkey                                                     |
| **Docker** *(optional)* | Only if you run Qdrant locally | Docker Desktop, OrbStack, colima, etc.                                                   |

### Choose a setup

| Setup                            | Best for                                                       | Config                                                                    |
| -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Recommended first-time**       | Best extraction and embedding quality with local Qdrant        | [Hosted models config](docs/config/hosted-models.md)                      |
| **Local and free**               | Private, free testing and local-first use                      | [Local config guide](docs/config/local.md)                                |
| **Hosted Qdrant + local Ollama** | Sharing memory across machines while keeping model calls local | [Hosted Qdrant + local models](docs/config/hosted-qdrant-local-models.md) |
| **Fully hosted**                 | Teams that want managed vector storage and hosted models       | [Fully hosted config](docs/config/fully-hosted.md)                        |

### Configure

Pick the setup guide above for the copy-paste config. Config lives at `~/.bikky/config.json`, and you can also set `QDRANT_URL` and `QDRANT_API_KEY` as environment variables.

For hosted models, custom providers, multiple profiles, or advanced tuning, use the full configuration guide.

> 📖 **Full configuration guide:** [docs/configuration.md](docs/configuration.md)
>
> 🛠 Want to add a new embedding or LLM provider (Vertex, OpenRouter, etc.)? See **[CONTRIBUTING.md](CONTRIBUTING.md)** — it's a single-file change.

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

## License

AGPL-3.0 — see [LICENSE](LICENSE).
