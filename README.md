<h1 align="center">bikky</h1>

<p align="center"><b>Persistent memory for AI coding agents — built for teams and multi-agent engineering workflows.</b></p>

bikky provides long-term memory for MCP-capable AI coding agents. It exposes memory tools over the Model Context Protocol (MCP), stores facts in Qdrant, and can run a local daemon that extracts durable facts from supported transcript sources. Teams can share memory across tools, repos, and engineers without treating chat history or closed PRs as the source of truth.

<p align="center">
  <img src="https://raw.githubusercontent.com/bikky-dev/bikky/main/docs/diagrams/team-memory.svg" alt="Memory — facts flow from individual sessions into a self-curating knowledge store shared across your team" width="720" />
</p>

<p align="center"><i>Selected knowledge flows from supported sessions into a store that curates itself over time — deduplicating, distilling, and decaying stale facts — so future sessions can start with more context.</i></p>

### Who it's for

- 👥 **Teams & software factories** — What one engineer's agent learns today can be recalled by other agents on the team tomorrow. Shared memory makes institutional knowledge queryable, helps onboarding, and reduces convention drift and repeated rediscovery.
- 🤖 **Multi-agent engineering workflows** — Multiple MCP-capable agent sessions can share codebase context, conventions, and recent decisions instead of re-learning them from scratch.

---

### How bikky works

bikky gives your agent memory tools and runs a small background service after `bikky setup`. You keep working normally; bikky captures useful facts from supported transcript sources, organizes them, recalls them in future sessions, and keeps the store tidy over time.

- **Capture** — Facts are extracted automatically from supported session transcripts without requiring manual notes for every fact.
- **Classify** — Memories are grouped as **engineering**, **product**, or **system** so they stay easy to browse and filter.
- **Recall** — New sessions can recall from the same store via semantic search.
- **Curate** — bikky merges duplicates, fades stale facts, resolves contradictions, distills recurring patterns, and builds an entity graph over time.
- **Compound** — Later sessions can start with more context because memory accumulates.
- **Route** — Optionally keep team, client, or environment-specific memory in separate Qdrant destinations from one install. See [separate memory stores](#optional-separate-memory-stores).

Subtypes keep recall precise without making setup harder:

- **Engineering** — codebase maps, architecture decisions, infra topology, access patterns, operational procedures, troubleshooting gotchas, conventions, preferences, person/ownership context, working agreements, and durable activity events.
- **Product** — domain rules, product decisions, requirements, user workflows, roadmap items, success metrics, and market insights.
- **System** — session indexes, episodes, workstreams, and feedback signals.

---

## Supported integrations

bikky has two integration surfaces: MCP tool access for agents and optional background transcript capture. Tool access is broader than transcript capture.

### Coding agents and MCP clients

| Client or agent | MCP tool access | `bikky setup` registration | Background transcript capture |
| --- | --- | --- | --- |
| GitHub Copilot | Supported | Supported via `~/.copilot/mcp-config.json` | Supported from `~/.copilot/session-state` |
| Claude Code | Supported | Supported via the `claude` CLI or `~/.claude.json` fallback | Supported from `~/.claude/projects` |
| Cursor and other stdio MCP clients | Standard MCP server is available via `npx -y bikky mcp` | Not auto-configured today | No built-in watcher today |

If your client can launch a stdio MCP server, it can use bikky's memory tools after manual configuration. bikky does not currently ship Cursor-specific setup or transcript parsing. Automatic transcript ingestion is implemented for GitHub Copilot and Claude Code.

### Storage and model providers

| Component | Supported today | Notes |
| --- | --- | --- |
| Vector store | Qdrant | Local Docker, Qdrant Cloud, or self-hosted Qdrant. Qdrant is required. |
| `embedding.provider` | `ollama`, `openai`, `bedrock`, `portkey` | Used to embed memories for semantic search. |
| `llm.provider` | `ollama`, `openai`, `bedrock`, `portkey` | Used for extraction, curation, distillation, and relation inference. |

Portkey support means bikky talks to Portkey as the configured gateway; upstream model availability, routing, and fallbacks are controlled by your Portkey configuration. Providers not listed above are not built in today, but the provider registry is designed to make additions small and reviewable.

---

## Quick start

This is the fastest path to a working memory store: Qdrant runs locally, while hosted embeddings and LLM calls handle extraction and recall without running local models.

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
    "dimensions": 1024,
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

# 3. Register bikky with supported clients and start the background service
bikky setup            # writes MCP config for GitHub Copilot + Claude Code, then starts the daemon
```

`npm install -g bikky` runs a best-effort postinstall setup hook for convenience. It never fails the install, and you should still run `bikky setup` after writing your config to make setup explicit and repeatable.

Restart your editor. The memory tools appear automatically in GitHub Copilot and Claude Code; configure other stdio MCP clients manually with `npx -y bikky mcp`.

```bash
bikky status           # confirms Qdrant, embeddings, daemon, and UI health
```

At this point, you can continue with local Qdrant or move the vector store to Qdrant Cloud later for a shared team setup.

For other deployment shapes — fully hosted, 100% local, or hosted Qdrant with local models — see [Setup options](#setup-options).

---

## Setup options

bikky supports four common setup shapes. Pick based on where you want Qdrant to run and where model calls should happen.

### What you need

| Component               | Required                       | Options                                                                                  |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| **Node.js**             | ≥ 20                           | `nvm install 20` or your package manager                                                 |
| **Vector store**        | Qdrant                         | Local Docker · [Qdrant Cloud](https://cloud.qdrant.io) · Self-hosted                     |
| **Embeddings**          | One provider                   | Portkey · OpenAI · Ollama · Bedrock                                                     |
| **LLM**                 | One provider                   | Portkey · OpenAI · Ollama · Bedrock                                                     |
| **Docker** *(optional)* | Only if you run Qdrant locally | Docker Desktop, OrbStack, colima, etc.                                                   |

Both `embedding.provider` and `llm.provider` accept the same values: `ollama`, `openai`, `bedrock`, or `portkey`. Portkey can be used as a hosted gateway when you want one configured provider in bikky and upstream routing/fallbacks managed outside bikky. The documented examples use **1024-dimensional embeddings** because that size works across the built-in provider examples. Some providers expose larger native dimensions (for example OpenAI `text-embedding-3-small` can return 1536), but using 1024 keeps the documented setup portable without rebuilding every collection.

> ⚠️ **Qdrant Cloud free tier does not include automatic backups.** Deleted collections cannot be recovered. If your memory data is valuable, use a paid Qdrant Cloud plan (which includes daily backups), run Qdrant locally with your own backup strategy, or periodically export snapshots via the [Qdrant snapshots API](https://qdrant.tech/documentation/concepts/snapshots/).

### Choose a setup

| Setup                            | Use when                                                       | Config                                                                  |
| -------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Fully hosted**                 | Teams want managed vector storage and hosted models            | [Fully hosted config][fully-hosted-config]                              |
| **Local Qdrant + hosted models** | You want local vector storage with hosted extraction/embedding | [Hosted models config][hosted-models-config]                            |
| **Local and free**               | You are evaluating locally and can accept local-model quality  | [Local config guide][local-config]                                      |
| **Hosted Qdrant + local Ollama** | You want shared vectors while keeping model calls local        | [Hosted Qdrant + local models][hosted-qdrant-local-models-config]       |

### Configuration basics

Pick the setup guide above for the copy-paste config. All setup shapes use the same three building blocks:

- **Qdrant** — where vectors and memory payloads are stored.
- **Embeddings** — how facts become searchable vectors.
- **LLM** — how session transcripts are extracted, curated, and distilled.

Config lives at `~/.bikky/config.json`, or at `BIKKY_HOME/config.json` when `BIKKY_HOME` is set. You can keep credentials out of the file with environment variables such as `QDRANT_URL`, `QDRANT_API_KEY`, and provider API keys.

`bikky setup` also provisions `identity.user_id` / `identity.user_name` when they are missing. New memory writes store canonical `origin` metadata with the configured human user, the acting agent or daemon/UI surface, the interface, and the operation. MCP clients cannot supply or spoof `origin.user`; if config, env, Git, and shell identity detection all fail, bikky falls back to the local hostname.

For hosted models, custom providers, multiple profiles, or advanced tuning, use the full configuration guide.

> 📖 **Full configuration guide:** [docs/configuration.md][configuration-guide]
>
> 🔒 **Privacy-first setup:** [local storage, local models, and transcript-capture controls][privacy-quickstart]
>
> 🛠 Want to add a new embedding or LLM provider (Vertex, OpenRouter, etc.)? See **[CONTRIBUTING.md][contributing]** — it's a single-file change.

#### Optional: separate memory stores

Most installs use one Qdrant destination. If you need clean separation later, replace the single `qdrant_url` / `collection` fields with named `destinations[]`:

```jsonc
{
  "destinations": [
    {
      "name": "platform",
      "description": "Shared platform engineering memory.",
      "qdrant_url": "https://platform.cloud.qdrant.io:6333",
      "qdrant_api_key": "...",
      "collection": "bikky-platform",
      "default": true
    },
    {
      "name": "client-a",
      "description": "Client A project memory.",
      "qdrant_url": "https://client-a.cloud.qdrant.io:6333",
      "qdrant_api_key": "...",
      "collection": "bikky-client-a"
    }
  ],
  "default_search_scope": "routed"
}
```

That is enough for explicit selection in the UI and tools. Add routing rules only when you want automatic placement by cwd, entity, content, or metadata. Search tools can also use `search_scope: "all"` or a named/listed scope when context may span stores. Existing single-Qdrant configs continue to work.

> 📖 **Details:** [multi-destination configuration](https://github.com/bikky-dev/bikky/blob/main/docs/configuration.md#multi-destination-routing)

[fully-hosted-config]: https://github.com/bikky-dev/bikky/blob/main/docs/config/fully-hosted.md
[hosted-models-config]: https://github.com/bikky-dev/bikky/blob/main/docs/config/hosted-models.md
[local-config]: https://github.com/bikky-dev/bikky/blob/main/docs/config/local.md
[hosted-qdrant-local-models-config]: https://github.com/bikky-dev/bikky/blob/main/docs/config/hosted-qdrant-local-models.md
[configuration-guide]: https://github.com/bikky-dev/bikky/blob/main/docs/configuration.md
[privacy-quickstart]: https://github.com/bikky-dev/bikky/blob/main/docs/privacy-first.md
[contributing]: https://github.com/bikky-dev/bikky/blob/main/CONTRIBUTING.md

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
  <img src="https://raw.githubusercontent.com/bikky-dev/bikky/main/docs/screenshots/dashboard.png" alt="Dashboard — overview stats, category breakdown, recent facts" width="720" />
</p>
<p align="center"><i>Dashboard — memory stats, category breakdown, and recent facts at a glance</i></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/bikky-dev/bikky/main/docs/screenshots/memory.png" alt="Memory browser — search, filter, and browse current user-facing memories" width="720" />
</p>
<p align="center"><i>Memory browser — search, filter by category, subtype, entity, usefulness, date, and sort order</i></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/bikky-dev/bikky/main/docs/screenshots/graph.png" alt="Entity graph — interactive visualization of entity relationships" width="720" />
</p>
<p align="center"><i>Entity graph — interactive visualization of how concepts, people, and services relate</i></p>

The UI reads from your existing `~/.bikky/config.json` (or `BIKKY_HOME/config.json`) — no extra configuration required.

By default, the dashboard, memory list, and search results show current user-facing memories only. Internal telemetry, system lifecycle summaries (`session_index`, `episode`, `workstream`), entity sidecars, and superseded archive records are hidden from the main views so counts match what you normally mean by "memories." Diagnostic API queries can still request those records explicitly, including superseded records with `include_superseded=true`.

Memory cards and detail pages also surface provenance from canonical `origin` metadata: the configured user, origin surface/operation, agent, last operation, repo, branch, workstream, task, session, and episode when present. Older records that only have legacy `source`, `actor_id`, or `metadata.actor_label` still display useful fallback labels.

## CLI

```bash
bikky mcp       # start MCP server (stdio) — used by editors
bikky setup     # install MCP configs for GitHub Copilot + Claude Code, then start the daemon
bikky start     # alias for setup
bikky stop      # stop the background daemon
bikky daemon    # run the daemon in the foreground
bikky status    # check memory system health
bikky ui        # launch the local web dashboard
bikky render    # render a prompt to JSON (for eval harnesses & debugging)
```

`bikky status` is the first thing to run when setup feels wrong. It checks the config, Qdrant, embeddings, background daemon, and local UI health, then tells you what needs attention. Use `bikky status --json` for automation.

## Privacy and transcript capture

bikky stores memory in the Qdrant destination you configure. The daemon runs locally and reads supported coding-agent transcript locations so it can extract durable facts for future sessions:

- GitHub Copilot session state: `~/.copilot/session-state`
- Claude Code project transcripts: `~/.claude/projects`

Only the configured daemon process reads these files. Extracted facts are redacted before storage, but they are still sent to your configured LLM provider for extraction unless you use a local provider such as Ollama. To disable transcript capture, set the relevant watcher to `false` in `~/.bikky/config.json`:

```json
{
  "watchers": {
    "copilot": { "enabled": false },
    "claude": { "enabled": false }
  }
}
```

You can also set `daemon.extract_every_sec` to `0` to disable background extraction while keeping MCP recall tools available.

For a local-storage, local-model setup that minimizes what leaves your machine, see the [privacy-first quickstart][privacy-quickstart].

## Support and contact

For questions, bugs, and feature requests, please use [GitHub issues](https://github.com/bikky-dev/bikky/issues). For maintainer contact, reach Saber Zrelli on GitHub: [@zrelli-s](https://github.com/zrelli-s).

## License

AGPL-3.0 — see [LICENSE](https://github.com/bikky-dev/bikky/blob/main/LICENSE).
