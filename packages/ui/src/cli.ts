#!/usr/bin/env node
/**
 * bikky-ui CLI entry point.
 * Starts the local HTTP server and opens the browser.
 */

import { startServer, stopServer } from "./server.js";
import type { AddressInfo } from "node:net";

const PORT = parseInt(process.env.BIKKY_UI_PORT || "1422", 10);
const SHOULD_OPEN_BROWSER = !process.env.BIKKY_UI_NO_OPEN && process.env.CI !== "1";

console.log(`🧠 bikky ui starting on ${PORT === 0 ? "an available local port" : `http://localhost:${PORT}`}`);

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

  server.on("listening", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address !== null
      ? (address as AddressInfo).port
      : PORT;
    const url = `http://localhost:${actualPort}`;

    console.log(`✅ bikky ui running at ${url} — press Ctrl+C to stop\n`);
    if (!SHOULD_OPEN_BROWSER) return;

    import("open")
      .then((mod) => mod.default(url))
      .catch(() => {
        console.log(`  → Open ${url} in your browser`);
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
