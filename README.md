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

<p align="center"><i>Knowledge flows from every session into a store that curates itself over time — deduplicating, distilling, and decaying stale facts — so every future session starts smarter. Share the workspace across a team, or keep it solo.</i></p>

---

### The problem

The most valuable things you and your agents learn — why a config value exists, which deploy step matters, what broke last quarter, the convention you settled on yesterday — happen *during* sessions. And then they vanish when the session closes. Whether you're a team — where knowledge lives in heads, chat threads, and closed PRs, and every new engineer's agent has to learn it from scratch — or a solo power dev juggling dozens of agentic sessions a day across multiple tools that don't remember each other, it's the same wall. Hand-written docs drift the moment they're published.

### How bikky solves it

| | |
|---|---|
| **Capture** | Facts are extracted automatically from session transcripts — no manual docs to write |
| **Recall** | Every new session — yours or a teammate's — recalls from the same store via semantic search |
| **Curate** | Deduplication, confidence decay, contradiction detection, and distillation run autonomously |
| **Compound** | Session 50 is dramatically better than session 1 — accumulated memory, not better prompts |

---

## Quick start

The fastest way to try bikky: **100% local, free, no accounts** — Qdrant in Docker, embeddings via Ollama.

```bash
# 1. Pull and run Qdrant (vector store)
docker run -d --name qdrant -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant

# 2. Install Ollama (https://ollama.com) and pull the default embedding model
ollama pull qwen3-embedding:0.6b

# 3. Install and start bikky
npm install -g bikky
echo '{ "qdrant_url": "http://localhost:6333" }' > ~/.bikky/config.json
bikky setup            # writes MCP config for Copilot + Claude Code, then starts the daemon
```

Restart your editor — the memory tools (`memory_store`, `memory_recall`, …) appear automatically.

```bash
bikky status           # validate config, Qdrant, embeddings, daemon, and UI health
```

That's the whole thing. From here you can swap any piece (hosted Qdrant, OpenAI / Bedrock embeddings, a hosted LLM for richer daemon distillation) — see **Setup** below.

---

## Setup

### Prerequisites

| | Required | Options |
|---|---|---|
| **Node.js** | ≥ 20 | `nvm install 20` or your package manager |
| **Vector store** | Qdrant | **Local Docker** (free, recommended for dev) · **[Qdrant Cloud](https://cloud.qdrant.io)** (free tier, 1 GB) · **Self-hosted** anywhere reachable |
| **Embeddings** | One provider | **[Ollama](https://ollama.com)** local (free, default) · **OpenAI** · **AWS Bedrock** · **[Portkey](https://portkey.ai)** gateway |
| **LLM** *(optional)* | Used by the daemon for distillation & extraction | Same provider list as embeddings — leave on Ollama for a fully-local stack |
| **Docker** *(optional)* | Only if you run Qdrant locally | Docker Desktop, OrbStack, colima, etc. |

### Install

```bash
npm install -g bikky          # CLI + MCP server + daemon
npm install -g bikky-ui       # optional web dashboard
```

### Pick your stack

- **Fully local & free** — Qdrant in Docker + Ollama. Best for solo dev, no data leaves your machine. (See Quick start.)
- **Hosted Qdrant + local Ollama** — Qdrant Cloud free tier for shared/team memory; embeddings still local.
- **Fully hosted** — Qdrant Cloud + OpenAI / Bedrock / Portkey for embeddings and LLM. Best for teams that want a single shared memory across many machines.

### Configure

Three ways to provide credentials, pick one:

```bash
# A) Let your agent do it
> "Call configure_credentials with my Qdrant URL (and API key if needed)"

# B) Config file (~/.bikky/config.json)
echo '{ "qdrant_url": "http://localhost:6333" }' > ~/.bikky/config.json

# C) Environment variables
export QDRANT_URL="http://localhost:6333"
# export QDRANT_API_KEY="…"   # only for Qdrant Cloud / authenticated self-hosted
```

> 💡 **Tip:** Set `BIKKY_HOME` to relocate the config dir (defaults to `~/.bikky/`). Useful for tests, multiple profiles, or sandboxed setups.

> 📖 **Full configuration reference** — providers, models, daemon settings, env vars, copy-paste examples for every stack: **[docs/configuration.md](docs/configuration.md)**
>
> 🛠 Want to add a new embedding or LLM provider (Vertex, OpenRouter, etc.)? See **[CONTRIBUTING.md](CONTRIBUTING.md)** — it's a single-file change.

---

## How it works

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/bikky@latest/docs/diagrams/architecture.svg" alt="Architecture" width="600" />
</p>

**MCP Server** — tools your agent calls directly:

`memory_store` · `memory_recall` · `memory_entity` · `memory_relations` · `memory_forget` · `memory_verify` · `memory_heartbeat` · `memory_review` · `configure_credentials` · `verify_connection`

**Daemon** — background process that passively watches session logs, extracts structured facts, writes lightweight session indexes, captures coherent episode summaries, updates current-state workstream summaries, infers entity relationships from recently changed facts, and runs the consolidation pipeline. Lifecycle memory is daemon-owned so agents do not need to remember summary/distillation tool calls.

---

## Memory ontology

bikky separates what a memory is about from where it came from. New captures use four top-level categories, concrete subtypes, small object kinds, activity domains, and provenance fields:

```text
Workspace
  Domain
    Project / repo / surface
      Workstream
        Episodes
          Facts, decisions, preferences, activity events, operational notes
        Current-state summaries
          What matters now, open questions, blockers
    Cross-cutting memory
      Durable patterns, entity relationships, telemetry
```

This gives each memory enough context to be recalled precisely without forcing every note into a rigid project hierarchy.

`category` is the broad subject area:

| Category | Captures |
|----------|----------|
| `engineering` | Codebase maps, architecture decisions, infrastructure topology, access patterns, operational procedures, troubleshooting gotchas, and engineering conventions |
| `product` | Domain rules, product decisions, requirements, user workflows, roadmap items, success metrics, and market insight |
| `human` | Preferences, person profiles, ownership notes, working agreements, and durable actor-action activity events |
| `system` | Bikky lifecycle memory: session indexes, episodes, workstreams, recall/feedback/outcome telemetry, and aggregate rollups |

`memory_subtype` is the precise capture shape inside a category:

| Category | Subtypes |
|----------|----------|
| `engineering` | `codebase_map`, `architecture_decision`, `infra_topology`, `access_pattern`, `operational_procedure`, `troubleshooting_gotcha`, `convention` |
| `product` | `domain_rule`, `product_decision`, `product_requirement`, `user_workflow`, `roadmap_item`, `success_metric`, `market_insight` |
| `human` | `preference`, `person_profile`, `ownership_note`, `working_agreement`, `activity_event` |
| `system` | `session_index`, `episode`, `workstream`, `recall_event`, `feedback_event`, `outcome_event`, `aggregate_rollup` |

`domain` is an activity/knowledge profile. The initial canonical domains are:

| Domain | Purpose |
|--------|---------|
| `software_engineering` | Default for coding-agent captures: repos, code, infrastructure, releases, incidents |
| `product_strategy` | Roadmap, positioning, experiments, customer insight, product decisions |
| `business_operations` | Company processes, vendors, compliance, obligations, recurring workflows |
| `research` | Source-backed investigation, hypotheses, contradictions, synthesis |
| `personal_productivity` | Individual goals, routines, preferences, projects, habits |

`kind` stays small (`fact`, `summary`, `distilled`, `relation`, `telemetry`). `source` is the creator class (`agent`, `system`, `user`, or `docs`). `actor_id` records the stable person or agent associated with a capture/action, and `workspace_id` scopes shared team memory. Legacy stored categories are read through compatibility aliases; this release does not migrate existing stored memories in place.

---

## Self-curation

Raw fact accumulation creates noise. bikky keeps the knowledge store clean automatically:

- **Deduplication** — content hash + vector similarity merges near-identical facts
- **Ontology scope fields** — optional `workspace_id`, repo, workstream, and episode metadata make recall more precise
- **Confidence decay** — old facts lose weight and surface for review
- **Contradiction detection** — conflicting facts are resolved, not silently stacked
- **Distillation** — recurring patterns across sessions consolidate into higher-level insights
- **Entity graph** — relationships between concepts are inferred incrementally for richer recall

---

## Web UI

[`bikky-ui`](packages/ui) is a local dashboard for browsing and managing your team's memory — facts, entities, quality metrics, aggregate impact insights, and the relationship graph.

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

`bikky status` is the first thing to run when setup feels wrong. It validates the
config file, highlights env vars that override it, checks Qdrant reachability and
payload-index readiness without mutating the collection, runs a live embedding
smoke check, validates the configured LLM provider name without sending a chat
request, and reports daemon maintenance plus UI health. Use `bikky status --json` for automation,
`--no-live` to skip the embedding call, and `--no-ui` to skip the local UI probe.

### `bikky render` — inspect prompts

Render any of bikky'''s prompts to JSON without booting the MCP server. Useful for
external evaluation harnesses, prompt debugging, and reproducing model calls.

```bash
bikky render --list                                    # list available prompts
echo '''{"transcript":"..."}''' | bikky render extraction  # via stdin
bikky render extraction --input case.json              # via file
```

Output: a JSON object with `promptName`, `messages`, `temperature`,
`max_tokens`, and `response_format` — exactly what bikky sends to the LLM.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
