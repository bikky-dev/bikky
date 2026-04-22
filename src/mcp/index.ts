/**
 * bikky MCP Server — episodic memory via Qdrant Cloud.
 *
 * Provides persistent memory across AI coding sessions. All facts, relations,
 * and entity context live as Qdrant points with vector embeddings + structured
 * payloads. Config stored in ~/.bikky/config.json.
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

  // Initialize embedding provider
  const embCfg = initEmbedding({
    provider: cfg.embedding.provider,
    baseUrl: cfg.embedding.base_url,
    model: cfg.embedding.model,
    dimensions: cfg.embedding.dimensions,
    apiKey: cfg.embedding.api_key ?? null,
  });
  log("INFO", `Embedding: ${embCfg.provider}/${embCfg.model} (${embCfg.dimensions}d) @ ${embCfg.baseUrl || "(sdk)"}`);

  if (qUrl && qKey) {
    try {
      await ensureCollection(QDRANT_INDEXES);
      setReady(true);
      log("INFO", "Memory system ready ✓");
    } catch (e) {
      log("ERROR", `Failed to initialize collection: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    const missing: string[] = [];
    if (!qUrl) missing.push("qdrant-url");
    if (!qKey) missing.push("qdrant-api-key");
    log("INFO", `Memory not configured — missing: ${missing.join(", ")}. Use get_setup_status + configure_credentials.`);
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
