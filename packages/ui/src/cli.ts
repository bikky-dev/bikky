#!/usr/bin/env node
/**
 * bikky-ui CLI entry point.
 * Starts the local HTTP server and opens the browser.
 */

import { startServer, stopServer } from "./server.js";

const PORT = parseInt(process.env.BIKKY_UI_PORT || "1422", 10);

console.log(`🧠 bikky ui starting on http://localhost:${PORT}`);

try {
  const server = startServer(PORT);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n❌ Port ${PORT} is already in use.`);
      console.error(`   Another bikky-ui instance may be running.`);
      console.error(`   Set BIKKY_UI_PORT=<port> to use a different port.\n`);
      process.exit(1);
    }
    throw err;
  });

  // Open browser after server confirms listening
  server.on("listening", () => {
    console.log(`✅ bikky ui running — press Ctrl+C to stop\n`);
    import("open")
      .then((mod) => mod.default(`http://localhost:${PORT}`))
      .catch(() => {
        console.log(`  → Open http://localhost:${PORT} in your browser`);
      });
  });
} catch (err) {
  console.error("Failed to start bikky-ui:", err);
  process.exit(1);
}

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
