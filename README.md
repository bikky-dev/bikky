<h1 align="center">bikky</h1>

<p align="center"><b>Persistent memory for AI coding agents — for teams, and for solo power users.</b></p>

bikky gives AI coding agents (GitHub Copilot, Claude Code, Cursor, and other MCP clients) long-term memory that persists across sessions, across tools, and across your whole team. Whether you're a team that wants every engineer's agent to start from the same knowledge base, or a solo power dev running a dozen agentic sessions a day, bikky captures what's learned *during* sessions so future sessions start smarter.

### Who it's for

| | |
|---|---|
| 👥 **Teams & software factories** | What one engineer's agent learns today, every agent on the team can recall tomorrow. Shared memory turns institutional knowledge into something queryable instead of tribal — onboarding accelerates, conventions stop drifting, and the same lesson never gets re-learned twice. |
| 🧑‍💻 **Solo AI power devs** | You run multiple Cursor / Claude Code / Copilot sessions every day and you're tired of re-explaining the codebase, the conventions, and last week's decisions to each new agent. bikky remembers across every session and every tool. |

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/bikky@latest/docs/diagrams/team-memory.svg" alt="Memory — facts flow from individual sessions into a self-curating knowledge store, shared across your team (or kept just for you)" width="720" />
</p>

<p align="center"><i>Knowledge flows from every session into a store that curates itself over time — deduplicating, distilling, and decaying stale facts — so every future session starts smarter. Share it across a team, or keep it solo.</i></p>

---

### The problem

The most valuable things you and your agents learn — why a config value exists, which deploy step matters, what broke last quarter, the convention you settled on yesterday — happen *during* sessions. And then they vanish when the session closes. Whether you're a team — where knowledge lives in heads, chat threads, and closed PRs, and every new engineer's agent has to learn it from scratch — or a solo power dev juggling dozens of agentic sessions a day across multiple tools that don't remember each other, it's the same wall. Hand-written docs drift the moment they're published.

### How bikky solves it

bikky gives your agent memory tools and runs a small background service after `bikky setup`. You keep working normally; bikky captures useful facts, recalls them in future sessions, and keeps the store tidy over time.

| | |
|---|---|
| **Capture** | Facts are extracted automatically from session transcripts — no manual docs to write |
| **Recall** | Every new session — yours or a teammate's — recalls from the same store via semantic search |
| **Curate** | Deduplication, confidence decay, contradiction detection, and distillation run autonomously |
| **Compound** | Session 50 is dramatically better than session 1 — accumulated memory, not better prompts |

---

## Quick start

The easiest way to try bikky is **100% local, free, and account-free**: Qdrant in Docker, embeddings via Ollama. bikky has one required setting: where Qdrant lives. Everything else has local defaults.

```bash
# 1. Pull and run Qdrant (vector store)
docker run -d --name qdrant -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant

# 2. Install Ollama (https://ollama.com) and pull the default embedding model
ollama pull qwen3-embedding:0.6b

# 3. Install bikky
npm install -g bikky
mkdir -p ~/.bikky
echo '{ "qdrant_url": "http://localhost:6333" }' > ~/.bikky/config.json

# 4. Register bikky with your editor and start the background service
bikky setup            # writes MCP config for Copilot + Claude Code, then starts the daemon
```

Restart your editor. The memory tools appear automatically in supported MCP clients.

```bash
bikky status           # confirms Qdrant, embeddings, daemon, and UI health
```

That's it. You can use the local setup forever, or swap in hosted pieces later.

---

## Setup options

Start with the local path unless you already know you want hosted infrastructure.

### What you need

| | Required | Options |
|---|---|---|
| **Node.js** | ≥ 20 | `nvm install 20` or your package manager |
| **Vector store** | Qdrant | Local Docker (recommended first) · [Qdrant Cloud](https://cloud.qdrant.io) · Self-hosted |
| **Embeddings** | One provider | Ollama local by default · OpenAI / Bedrock / Portkey if you prefer hosted |
| **Docker** *(optional)* | Only if you run Qdrant locally | Docker Desktop, OrbStack, colima, etc. |

### Choose a setup

| Setup | Best for | Config |
|---|---|---|
| **Local and free** | First install, solo use, private testing | `{"qdrant_url":"http://localhost:6333"}` |
| **Hosted Qdrant + local Ollama** | Sharing memory across machines while keeping embeddings local | Add your Qdrant Cloud URL and API key |
| **Fully hosted** | Teams that want managed vector storage and hosted models | Add Qdrant plus provider settings in [`docs/configuration.md`](docs/configuration.md) |

### Configure

Most users only need one of these:

```bash
mkdir -p ~/.bikky

# Local Qdrant
echo '{ "qdrant_url": "http://localhost:6333" }' > ~/.bikky/config.json

# Qdrant Cloud
echo '{ "qdrant_url": "https://your-cluster.cloud.qdrant.io:6333", "qdrant_api_key": "your-key" }' > ~/.bikky/config.json
```

You can also set `QDRANT_URL` and `QDRANT_API_KEY` as environment variables. For hosted models, custom providers, multiple profiles, or advanced tuning, use the full configuration guide.

> 📖 **Full configuration guide:** [docs/configuration.md](docs/configuration.md)
>
> 🛠 Want to add a new embedding or LLM provider (Vertex, OpenRouter, etc.)? See **[CONTRIBUTING.md](CONTRIBUTING.md)** — it's a single-file change.

---

## Self-curation

Raw fact accumulation creates noise. bikky keeps the knowledge store clean automatically:

- **Deduplication** — content hash + vector similarity merges near-identical facts
- **Context fields** — repo, task, and source metadata make recall more precise when available
- **Confidence decay** — old facts lose weight and surface for review
- **Contradiction detection** — conflicting facts are resolved, not silently stacked
- **Distillation** — recurring patterns across sessions consolidate into higher-level insights
- **Entity graph** — relationships between concepts are inferred incrementally for richer recall

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
