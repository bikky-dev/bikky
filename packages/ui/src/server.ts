/**
 * Local HTTP server for @bikky/ui.
 * Serves the React frontend + memory API routes.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve, type ServerType } from "@hono/node-server";
import { memoryRoutes } from "./routes/memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Hono {
  const app = new Hono();

  // CORS for local dev (Vite on different port)
  app.use("/api/*", cors());

  // Global error handler for API routes
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // Health check
  app.get("/health", (c) => c.json({ ok: true, service: "bikky-ui" }));

  // Memory API
  app.route("/api/memory", memoryRoutes);

  // Serve static frontend assets
  const publicDir = path.resolve(__dirname, "public");
  if (fs.existsSync(publicDir)) {
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), publicDir) }));

    // SPA fallback — serve index.html for all non-API, non-file routes
    app.get("*", (c) => {
      const indexPath = path.join(publicDir, "index.html");
      if (fs.existsSync(indexPath)) {
        return c.html(fs.readFileSync(indexPath, "utf-8"));
      }
      return c.text("bikky ui: frontend not built. Run `npm run build` in packages/ui/", 404);
    });
  } else {
    app.get("*", (c) => {
      if (c.req.path.startsWith("/api/")) return c.notFound();
      return c.text("bikky ui: frontend not built. Run `npm run build` in packages/ui/", 404);
    });
  }

  return app;
}

let _server: ServerType | null = null;

export function startServer(port = 1422): ServerType {
  const app = createApp();
  _server = serve({ fetch: app.fetch, port });
  return _server;
}

export function stopServer(): void {
  if (_server) {
    _server.close();
    _server = null;
  }
}
