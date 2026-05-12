#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_CATEGORIES = ["human", "preferences", "people", "team"];
const MIGRATION_ID = "008-remove-human-category";
const SCROLL_LIMIT = 256;
const APPLY_CHUNK_SIZE = 100;

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const configPath = valueArg("--config") ?? process.env.BIKKY_CONFIG ?? join(homedir(), ".bikky", "config.json");
const destinationFilter = valueArg("--destination");

function valueArg(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function destinationsFromConfig(config) {
  const destinations = Array.isArray(config.destinations) && config.destinations.length > 0
    ? config.destinations
    : [{
        name: "default",
        qdrant_url: config.qdrant_url,
        qdrant_api_key: config.qdrant_api_key,
        collection: config.collection ?? "bikky",
      }];

  return destinations
    .map((destination) => ({
      name: destination.name ?? "default",
      qdrantUrl: String(destination.qdrant_url ?? "").replace(/\/+$/, ""),
      qdrantApiKey: destination.qdrant_api_key ?? null,
      collection: destination.collection ?? config.collection ?? "bikky",
    }))
    .filter((destination) => destination.qdrantUrl.length > 0)
    .filter((destination) => !destinationFilter || destination.name === destinationFilter);
}

async function qdrantRequest(destination, method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (destination.qdrantApiKey) headers["api-key"] = destination.qdrantApiKey;
  const response = await fetch(`${destination.qdrantUrl}/collections/${destination.collection}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${destination.name}/${destination.collection} ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return response.json();
}

async function scrollLegacyCategory(destination, category) {
  const points = [];
  let offset = null;
  do {
    const body = {
      filter: { must: [{ key: "category", match: { value: category } }] },
      limit: SCROLL_LIMIT,
      with_payload: ["category", "memory_subtype", "superseded_by"],
    };
    if (offset) body.offset = offset;
    const response = await qdrantRequest(destination, "POST", "/points/scroll", body);
    points.push(...(response.result?.points ?? []));
    offset = response.result?.next_page_offset ?? null;
  } while (offset);
  return points;
}

async function setPayload(destination, ids, payload) {
  for (let i = 0; i < ids.length; i += APPLY_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + APPLY_CHUNK_SIZE);
    await qdrantRequest(destination, "POST", "/points/payload", {
      points: chunk,
      payload,
    });
  }
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const destinations = destinationsFromConfig(config);
if (destinations.length === 0) {
  throw new Error(destinationFilter
    ? `No configured destination named ${destinationFilter}`
    : "No configured Qdrant destinations found");
}

console.log(`${apply ? "APPLY" : "DRY RUN"} ${MIGRATION_ID}`);
console.log(`config=${configPath}`);

let total = 0;
for (const destination of destinations) {
  const byCategory = new Map();
  const bySubtype = new Map();

  for (const category of LEGACY_CATEGORIES) {
    const points = await scrollLegacyCategory(destination, category);
    if (points.length === 0) continue;
    byCategory.set(category, points);
    total += points.length;
    for (const point of points) {
      const subtype = point.payload?.memory_subtype ?? "(missing)";
      bySubtype.set(subtype, (bySubtype.get(subtype) ?? 0) + 1);
    }
  }

  const destinationTotal = Array.from(byCategory.values()).reduce((sum, points) => sum + points.length, 0);
  console.log(`${destination.name}/${destination.collection}: ${destinationTotal} point(s)`);
  for (const [category, points] of byCategory.entries()) {
    console.log(`  category=${category}: ${points.length}`);
  }
  if (bySubtype.size > 0) {
    console.log(`  subtypes: ${Array.from(bySubtype.entries()).map(([subtype, count]) => `${subtype}=${count}`).join(", ")}`);
  }

  if (!apply || destinationTotal === 0) continue;

  const migratedAt = new Date().toISOString();
  for (const [category, points] of byCategory.entries()) {
    await setPayload(destination, points.map((point) => point.id), {
      category: "engineering",
      taxonomy_migration: MIGRATION_ID,
      taxonomy_previous_category: category,
      taxonomy_migrated_at: migratedAt,
    });
  }
  console.log(`  applied: category=engineering`);
}

if (!apply) {
  console.log(`Dry run only. Re-run with --apply after explicit approval to update ${total} point(s).`);
}
