#!/usr/bin/env node
/**
 * Renders docs/diagrams/*.mmd → *.svg via @mermaid-js/mermaid-cli (mmdc).
 * Run: node scripts/build-diagrams.mjs
 */

import { readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIAGRAM_DIR = resolve(ROOT, "docs", "diagrams");

const mmds = readdirSync(DIAGRAM_DIR).filter((f) => f.endsWith(".mmd"));

if (mmds.length === 0) {
  console.log("No .mmd files found in docs/diagrams/");
  process.exit(0);
}

let failed = false;

for (const file of mmds) {
  const name = basename(file, ".mmd");
  const input = resolve(DIAGRAM_DIR, file);
  const output = resolve(DIAGRAM_DIR, `${name}.svg`);

  console.log(`  → rendering ${name}.svg …`);
  try {
    execSync(
      `npx mmdc -i "${input}" -o "${output}" -t neutral -b transparent --quiet`,
      { cwd: ROOT, stdio: "pipe" },
    );
    console.log(`  ✓ ${name}.svg`);
  } catch (err) {
    console.error(`  ✗ ${name}.svg failed: ${err.message}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log(`\n  ✅ ${mmds.length} diagrams rendered`);
