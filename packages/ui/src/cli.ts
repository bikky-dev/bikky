#!/usr/bin/env node
/**
 * @bikky/ui CLI entry point.
 * Starts the local HTTP server and opens the browser.
 */

import { startServer, stopServer } from "./server.js";

const PORT = parseInt(process.env.BIKKY_UI_PORT || "1422", 10);

console.log(`🧠 bikky ui starting on http://localhost:${PORT}`);

startServer(PORT);

// Open browser
import("open")
  .then((mod) => mod.default(`http://localhost:${PORT}`))
  .catch(() => {
    console.log(`  → Open http://localhost:${PORT} in your browser`);
  });

console.log(`✅ bikky ui running — press Ctrl+C to stop\n`);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Stopping bikky ui...");
  stopServer();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopServer();
  process.exit(0);
});
