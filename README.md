<p align="center">
  <img src="assets/bikky-tp.png" alt="bikky logo" width="180" />
</p>

<h1 align="center">bikky</h1>

<p align="center"><b>Shared persistent memory for AI coding agents.</b></p>

bikky gives your team's AI agents (GitHub Copilot, Claude Code, Cursor, Codex, and other MCP clients) long-term memory that persists across sessions and is shared across team members. It helps software factories become queryable organizations: what one engineer's agent learns today, every agent on the team knows tomorrow through a closed-loop memory system.

<p align="center">
  <img src="https://raw.githubusercontent.com/bikky-dev/bikky/main/docs/diagrams/team-memory.svg" alt="Team memory — facts flow from individual sessions into a shared, self-curating knowledge store" width="720" />
</p>

<p align="center"><i>Knowledge flows from every team member's sessions into a shared store that curates itself over time — deduplicating, distilling, and decaying stale facts — so every future session starts smarter.</i></p>

---

### The problem

Every engineering team runs on institutional knowledge — why that config value exists, which deploy steps matter, what broke last quarter. It lives in people's heads, chat threads, and closed PRs. When someone switches projects, it's gone. AI coding agents amplify this: teams generate more decisions and discoveries per day than anyone can track, and hand-written knowledge bases drift the moment they're published. The things learned *during* sessions — the most valuable knowledge — still vanish when the session closes.

### How bikky solves it

| | |
|---|---|
| **Capture** | Facts are extracted automatically from session transcripts — no manual docs to write |
| **Share** | Every team member's agent recalls from the same knowledge store via semantic search |
| **Curate** | Deduplication, confidence decay, contradiction detection, and distillation run autonomously |
| **Compound** | Session 50 is dramatically better than session 1 — accumulated memory, not better prompts |

---

## Quick start

```bash
npm install -g bikky
bikky install          # writes MCP config for Copilot + Claude Code
```

**Prerequisites:** [Qdrant Cloud](https://cloud.qdrant.io) (free tier, no credit card) + an embedding provider ([Ollama](https://ollama.com) runs locally for free, or use OpenAI / AWS Bedrock).

Then configure credentials — pick one:

```bash
# Option A: let your agent do it
> "Call configure_credentials with my Qdrant URL and API key"

# Option B: config file
echo '{ "qdrant_url": "https://…:6333", "qdrant_api_key": "…" }' > ~/.bikky/config.json

# Option C: env vars
export QDRANT_URL="https://…:6333" QDRANT_API_KEY="…"
```

Restart your editor — memory tools appear automatically.

> 📖 Full configuration reference (providers, models, daemon settings): **[docs/configuration.md](docs/configuration.md)**
>
> 🛠 Want to add a new embedding or LLM provider (Vertex, OpenRouter, etc.)? See **[CONTRIBUTING.md](CONTRIBUTING.md)** — it's a single-file change.

---

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/bikky-dev/bikky/main/docs/diagrams/architecture.svg" alt="Architecture" width="600" />
</p>

**MCP Server** — tools your agent calls directly:

`memory_store` · `memory_recall` · `memory_entity` · `memory_relations` · `memory_forget` · `memory_verify` · `memory_heartbeat` · `memory_review` · `configure_credentials` · `verify_connection`

**Daemon** — background process that passively watches session logs, extracts ontology-v2 facts, writes lightweight session indexes, captures coherent episode summaries, updates current-state workstream summaries, infers entity relationships, and runs the consolidation pipeline. Lifecycle memory is daemon-owned so agents do not need to remember summary/distillation tool calls.

---

## Self-curation

Raw fact accumulation creates noise. bikky keeps the knowledge store clean automatically:

- **Deduplication** — content hash + vector similarity merges near-identical facts
- **Ontology scope fields** — optional `workspace_id`, repo, workstream, and episode metadata make recall more precise
- **Confidence decay** — old facts lose weight and surface for review
- **Contradiction detection** — conflicting facts are resolved, not silently stacked
- **Distillation** — recurring patterns across sessions consolidate into higher-level insights
- **Entity graph** — relationships between concepts are inferred for richer recall

### Ranking formula

```
(vectorScore × 0.55 + freshness × 0.15 + reinforcement × 0.1 + importance × 0.1)
  × (0.7 + 0.3 × confidenceDecay)
```

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
  <img src="https://raw.githubusercontent.com/bikky-dev/bikky/main/docs/screenshots/dashboard.png" alt="Dashboard — overview stats, category breakdown, recent facts" width="720" />
</p>
<p align="center"><i>Dashboard — memory stats, category breakdown, and recent facts at a glance</i></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/bikky-dev/bikky/main/docs/screenshots/memory.png" alt="Memory browser — search, filter, and browse all stored facts" width="720" />
</p>
<p align="center"><i>Memory browser — search, filter by category/kind/source, and browse all stored facts</i></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/bikky-dev/bikky/main/docs/screenshots/graph.png" alt="Entity graph — interactive visualization of entity relationships" width="720" />
</p>
<p align="center"><i>Entity graph — interactive visualization of how concepts, people, and services relate</i></p>

The UI reads from your existing `~/.bikky/config.json` — no extra configuration required.

## CLI

```bash
bikky mcp       # start MCP server (stdio) — used by editors
bikky setup     # interactive setup wizard
bikky status    # check memory system health
bikky install   # write MCP config for Copilot + Claude Code
bikky templates # print config snippets for Copilot, Claude Code, Cursor, and Codex
bikky render    # render a prompt to JSON (for eval harnesses & debugging)
```

See **[docs/integrations.md](docs/integrations.md)** for copy-paste MCP templates.

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
