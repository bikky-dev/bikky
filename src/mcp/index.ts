/**
 * bikky MCP Server — episodic memory via Qdrant (Cloud, Docker, or self-hosted).
 *
 * Provides persistent memory across AI coding sessions. All facts, relations,
 * and entity context live as Qdrant points with vector embeddings + structured
 * payloads. Config stored in ~/.bikky/config.json.
 *
 * Boot resilience: every initialisation step is wrapped so a misconfigured
 * provider, missing key, or unreachable Qdrant cluster surfaces as a
 * `setup_required` status (with an actionable reason) instead of crashing the
 * MCP stdio transport. The MCP server always comes up; tools then degrade
 * gracefully via `requireReady()`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QDRANT_INDEXES } from "./taxonomy.js";
import {
  log,
  setQdrantUrl,
  setQdrantApiKey,
  setReady,
  setCollection,
  setSetupError,
  ensureCollection,
  initEmbedding,
} from "./api.js";
import { registerTools } from "./tools.js";
import { loadConfig } from "../config.js";

export async function startMcpServer(): Promise<void> {
  log("INFO", `Starting bikky MCP server (PID ${process.pid})`);

  const cfg = loadConfig();

  // Resolve credentials from config (which already merges env vars)
  const qUrl = cfg.qdrant_url?.replace(/\/+$/, "") || null;
  const qKey = cfg.qdrant_api_key || null;

  setQdrantUrl(qUrl);
  setQdrantApiKey(qKey);
  setCollection(cfg.collection);

  // Initialize embedding provider — wrapped so an unknown provider name or
  // misconfiguration produces a setup_required status instead of crashing the
  // MCP stdio transport. The server always comes up; tools degrade via
  // requireReady().
  try {
    const embCfg = initEmbedding({
      provider: cfg.embedding.provider,
      baseUrl: cfg.embedding.base_url,
      model: cfg.embedding.model,
      dimensions: cfg.embedding.dimensions,
      apiKey: cfg.embedding.api_key ?? null,
      extra: cfg.embedding.extra ?? {},
      timeoutMs: cfg.embedding.timeout_ms,
      retries: cfg.embedding.retries,
      retryBaseDelayMs: cfg.embedding.retry_base_delay_ms,
    });
    log("INFO", `Embedding: ${embCfg.provider}/${embCfg.model} (${embCfg.dimensions}d) @ ${embCfg.baseUrl || "(sdk)"}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setSetupError(`Embedding init failed: ${msg}`);
    log("ERROR", `Embedding init failed: ${msg}`);
    // Continue — server will report setup_required for memory tools.
  }

  if (qUrl) {
    try {
      await ensureCollection(QDRANT_INDEXES);
      setReady(true);
      log("INFO", `Memory system ready ✓ (Qdrant ${qKey ? "with" : "without"} api-key auth)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSetupError(`Qdrant initialization failed: ${msg}`);
      log("ERROR", `Failed to initialize collection: ${msg}`);
    }
  } else {
    log("INFO", "Memory not configured — missing: qdrant-url. Use get_setup_status + configure_credentials.");
  }

  const mcp = new McpServer({
    name: "bikky",
    version: "0.1.0",
  }, {
    instructions: "Shared memory tools for AI coding sessions. Store and recall facts, entities, and relationships across sessions.",
  });

  registerTools(mcp);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("INFO", "MCP server connected on stdio");

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      log("INFO", `Received ${sig}, shutting down...`);
      process.exit(0);
    });
  }
}
