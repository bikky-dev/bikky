#!/usr/bin/env node
import("../dist/cli.js").catch((e) => {
  console.error("mem00: failed to load —", e.message);
  console.error("Run `npm run build` first if developing locally.");
  process.exit(1);
});
