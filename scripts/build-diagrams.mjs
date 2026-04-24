#!/usr/bin/env node
/**
 * Renders docs/diagrams/*.mmd → *.svg via @mermaid-js/mermaid-cli (mmdc).
 * Run: node scripts/build-diagrams.mjs
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIAGRAM_DIR = resolve(ROOT, "docs", "diagrams");
const SCALE = 0.7; // render at 70% of default size

const mmds = readdirSync(DIAGRAM_DIR).filter((f) => f.endsWith(".mmd"));

if (mmds.length === 0) {
  console.log("No .mmd files found in docs/diagrams/");
  process.exit(0);
}

/** Scale the root <svg> max-width and viewBox dimensions by SCALE. */
function shrinkSvg(svgPath) {
  let svg = readFileSync(svgPath, "utf-8");

  // Scale the first max-width (on the root <svg> element)
  let first = true;
  svg = svg.replace(/max-width:\s*([\d.]+)px/, (_m, w) => {
    if (!first) return _m;
    first = false;
    return `max-width: ${(parseFloat(w) * SCALE).toFixed(1)}px`;
  });

  writeFileSync(svgPath, svg);
}

let failed = false;

for (const file of mmds) {
  const name = basename(file, ".mmd");
  const input = resolve(DIAGRAM_DIR, file);
  const output = resolve(DIAGRAM_DIR, `${name}.svg`);

  console.log(`  → rendering ${name}.svg …`);
  try {
    const puppeteerArgs = process.env.PUPPETEER_ARGS || "";
    const extra = puppeteerArgs.includes("--no-sandbox")
      ? ` -p '{"args":["--no-sandbox","--disable-setuid-sandbox"]}'`
      : "";
    execSync(
      `npx mmdc -i "${input}" -o "${output}" -t neutral -b transparent --quiet${extra}`,
      { cwd: ROOT, stdio: "pipe" },
    );
    shrinkSvg(output);
    console.log(`  ✓ ${name}.svg (scaled to ${SCALE * 100}%)`);
  } catch (err) {
    console.error(`  ✗ ${name}.svg failed: ${err.message}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log(`\n  ✅ ${mmds.length} diagrams rendered at ${SCALE * 100}% scale`);
