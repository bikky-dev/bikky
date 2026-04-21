/**
 * Events-based memory extraction — reads Copilot CLI events.jsonl transcripts,
 * extracts facts via LLM, and stores them in Qdrant with source: "cortex".
 *
 * Uses a JSON file for extraction state (high-water byte offsets) instead of SQLite.
 * Active session detection scans ~/.copilot/session-state/ for lock files.
 */

import { readFile, stat } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { glob } from "node:fs/promises";

import { loadConfig, STATE_DIR } from "../config.js";
import type { Mem00Config } from "../config.js";
import * as qdrant from "./qdrant.js";
import { chatCompletion } from "../llm/index.js";
import { detectContradiction } from "./consolidation.js";
import type { LogFn, StoreFact } from "./qdrant.js";

// ── Module state ─────────────────────────────────────────────────────────────

let logFn: LogFn = (() => {}) as unknown as LogFn;
let lastTickAt = 0;

export const setLogger = (fn: LogFn): void => {
  logFn = fn;
};

// ── Constants ────────────────────────────────────────────────────────────────

const EXTRACTABLE_TYPES = new Set([
  "user.message",
  "assistant.message",
  "session.compaction_complete",
]);

const EXTRACTION_PROMPT = `You are a knowledge extraction agent. Extract atomic facts from this conversation transcript that would be USEFUL TO A FUTURE ENGINEERING SESSION working on a different task.

## Utility test (apply to every fact before including it)
Ask: "Would a different engineer, working on a different task next week, benefit from knowing this?"
- YES → include it (architecture, decisions with rationale, infrastructure quirks, team ownership, durable project status)
- NO → skip it (debugging observations, test case details, intermediate errors, transient state)

## What to extract
- Architectural decisions with rationale ("chose X over Y because Z")
- Infrastructure details (endpoints, configs, service quirks, where credentials live)
- Project milestones and outcomes (PR merged, feature shipped, migration completed)
- Team ownership and roles (who owns what service)
- Tool configurations and conventions (deployment patterns, naming conventions)
- Durable observations (a service has a known limitation, a pattern that recurs)

## What to SKIP (critical — these are the most common mistakes)
- Debugging details: "test 67 fails because BSB has no hyphen" — transient, session-specific
- Intermediate errors: "got a 404 when calling X" — unless it reveals a permanent quirk
- Test case specifics: "CSV for test 82 was updated" — code change detail, not knowledge
- Step-by-step narration: "the user asked to fix X, then we looked at Y" — that's a log, not a fact
- Obvious or redundant: "the bot sends messages" — too generic to be useful
- Point-in-time debugging state: "there are 8 failures in tests 33, 34, 35..." — will be stale immediately
- Vague summaries without actionable detail: "WhatsApp bot adopted the enricher" — which enricher? which PR? If you can't add the detail, skip it

## Output format
Each fact must include an importance score (0.0-1.0):
- 0.8-1.0: Architectural decisions, infrastructure endpoints, security configurations
- 0.5-0.7: Project milestones, team ownership, tool conventions
- 0.2-0.4: Transient observations that might help short-term (if you must include them)
- Below 0.2: Don't include — it's noise

{"facts": [
  {
    "content": "The EC2 cortex instance has no git installed; deploys use pre-built Docker images pulled from ECR",
    "category": "infrastructure",
    "entities": ["ec2", "cortex", "ecr", "docker"],
    "confidence": 0.9,
    "importance": 0.8
  }
]}

- Category must be one of: infrastructure, decisions, observation, preferences, projects, team
- Entities should be lowercase identifiers (e.g. "qdrant", "cortex", "saber")
- Confidence 0.0-1.0: how certain (0.9 for explicit statements, 0.6 for inferences)
- Importance 0.0-1.0: how useful to future sessions (see scale above)

If there is nothing worth extracting, return: {"facts": []}`;

// ── JSON-file state persistence ──────────────────────────────────────────────

const EXTRACTION_STATE_PATH = join(STATE_DIR, "extraction-state.json");

interface ExtractionState {
  session_id: string;
  copilot_uuid: string;
  events_path: string;
  byte_offset: number;
  last_extracted_at: string | null;
  event_count: number;
}

type ExtractionStateMap = Record<string, ExtractionState>;

const loadExtractionStates = (): ExtractionStateMap => {
  try {
    if (existsSync(EXTRACTION_STATE_PATH)) {
      return JSON.parse(readFileSync(EXTRACTION_STATE_PATH, "utf-8")) as ExtractionStateMap;
    }
  } catch {
    logFn("WARN", "Failed to load extraction state, starting fresh");
  }
  return {};
};

const saveExtractionStates = (states: ExtractionStateMap): void => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(EXTRACTION_STATE_PATH, JSON.stringify(states, null, 2) + "\n", "utf-8");
};

const getExtractionState = (sessionId: string): ExtractionState | null => {
  const states = loadExtractionStates();
  return states[sessionId] ?? null;
};

const upsertExtractionState = (state: ExtractionState): void => {
  const states = loadExtractionStates();
  states[state.session_id] = state;
  saveExtractionStates(states);
};

// ── PID → Copilot UUID resolution ───────────────────────────────────────────

interface LockMapping {
  pid: number;
  uuid: string;
  eventsPath: string;
}

/**
 * Scan lock files to build PID → Copilot UUID mapping.
 * Copilot CLI writes `inuse.<pid>.lock` in each session directory.
 */
const resolveLockFiles = async (): Promise<LockMapping[]> => {
  const cfg = loadConfig();
  const copilotStateDir = cfg.watchers.copilot.path;
  const mappings: LockMapping[] = [];

  try {
    const pattern = join(copilotStateDir, "*/inuse.*.lock");
    for await (const lockPath of glob(pattern)) {
      const lockPathStr = String(lockPath);
      const parts = lockPathStr.split("/");
      const lockFile = parts.at(-1) ?? ""; // inuse.12345.lock
      const uuid = parts.at(-2) ?? "";     // session UUID

      const pidMatch = lockFile.match(/^inuse\.(\d+)\.lock$/);
      if (!pidMatch || !uuid) continue;

      const pid = parseInt(pidMatch[1]!, 10);
      const eventsPath = join(copilotStateDir, uuid, "events.jsonl");

      // Verify events.jsonl exists
      try {
        await stat(eventsPath);
        mappings.push({ pid, uuid, eventsPath });
      } catch {
        // No events.jsonl — skip
      }
    }
  } catch (e) {
    logFn("WARN", `Lock file scan failed: ${(e as Error).message}`);
  }

  return mappings;
};

/**
 * Check if a process is still running.
 */
const isProcessAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// ── Event reading ────────────────────────────────────────────────────────────

interface ParsedEvent {
  type: string;
  content: string;
  timestamp: string;
}

/**
 * Read new events from events.jsonl starting at the given byte offset.
 * Returns parsed extractable events and the new byte offset.
 */
const readNewEvents = async (
  eventsPath: string,
  byteOffset: number,
): Promise<{ events: ParsedEvent[]; newOffset: number; totalLines: number }> => {
  const fileStat = await stat(eventsPath);
  if (fileStat.size <= byteOffset) {
    return { events: [], newOffset: byteOffset, totalLines: 0 };
  }

  // Read from byte offset to end of file
  const buf = await readFile(eventsPath);
  const newContent = buf.subarray(byteOffset).toString("utf-8");

  const events: ParsedEvent[] = [];
  let totalLines = 0;

  for (const line of newContent.split("\n")) {
    if (!line.trim()) continue;
    totalLines++;

    try {
      const obj = JSON.parse(line) as {
        type: string;
        timestamp?: string;
        data?: Record<string, unknown>;
      };

      if (!EXTRACTABLE_TYPES.has(obj.type)) continue;

      const data = obj.data || {};
      let content = "";

      if (obj.type === "user.message") {
        content = (data.content as string) || "";
      } else if (obj.type === "assistant.message") {
        const parts: string[] = [];
        if (data.content) parts.push(data.content as string);
        if (data.reasoningText) parts.push(data.reasoningText as string);
        // Skip reasoningOpaque — encrypted noise
        content = parts.join("\n");
      } else if (obj.type === "session.compaction_complete") {
        content = (data.summaryContent as string) || "";
      }

      if (content.length > 0) {
        events.push({
          type: obj.type,
          content,
          timestamp: obj.timestamp || new Date().toISOString(),
        });
      }
    } catch {
      // Malformed line — skip
    }
  }

  return { events, newOffset: fileStat.size, totalLines };
};

/**
 * Build a compressed transcript from parsed events for LLM extraction.
 */
const buildTranscript = (events: ParsedEvent[]): string => {
  const lines: string[] = [];

  for (const ev of events) {
    const role = ev.type === "user.message"
      ? "USER"
      : ev.type === "assistant.message"
        ? "ASSISTANT"
        : "SUMMARY";

    // Truncate very long content (e.g. reasoning text)
    const text = ev.content.length > 2000
      ? ev.content.slice(0, 2000) + "…[truncated]"
      : ev.content;

    lines.push(`[${role}] ${text}`);
  }

  return lines.join("\n\n");
};

// ── LLM extraction ──────────────────────────────────────────────────────────

interface ExtractedFact {
  content: string;
  category: string;
  entities: string[];
  confidence: number;
  importance: number;
}

/**
 * Call the LLM to extract facts from a conversation transcript.
 */
const extractFacts = async (transcript: string): Promise<ExtractedFact[]> => {
  if (!transcript.trim()) return [];

  const result = await chatCompletion({
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: transcript },
    ],
    temperature: 0.1,
    max_tokens: 4000,
    response_format: { type: "json_object" },
  });

  if (!result) {
    logFn("WARN", "Extraction LLM call returned null");
    return [];
  }

  try {
    // Parse — handle {facts: [...]}, raw array, or single-fact object
    let parsed: unknown = JSON.parse(result);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const unwrapped = obj.facts || obj.results || obj.items;
      if (Array.isArray(unwrapped)) {
        parsed = unwrapped;
      } else if (obj.content && typeof obj.content === "string") {
        // Single fact object — wrap in array
        parsed = [obj];
      } else {
        // Try first array value from the object
        const firstVal = Object.values(obj).find(v => Array.isArray(v));
        parsed = firstVal || [obj];
      }
    }

    if (!Array.isArray(parsed)) {
      logFn("WARN", `Extraction LLM returned non-array: ${result.slice(0, 300)}`);
      return [];
    }

    return (parsed as Array<Record<string, unknown>>)
      .filter(f => f.content && typeof f.content === "string" && f.category)
      .map(f => ({
        content: f.content as string,
        category: f.category as string,
        entities: Array.isArray(f.entities) ? (f.entities as string[]).map(e => String(e).toLowerCase()) : [],
        confidence: typeof f.confidence === "number" ? f.confidence : 0.7,
        importance: typeof f.importance === "number" ? f.importance : 0.5,
      }))
      .filter(f => {
        if (f.importance < 0.3) {
          logFn("DEBUG", `Extraction: dropping low-importance fact (${f.importance}): "${f.content.slice(0, 80)}…"`);
          return false;
        }
        return true;
      });
  } catch (e) {
    logFn("WARN", `Extraction LLM parse error: ${(e as Error).message} — raw: ${result.slice(0, 200)}`);
    return [];
  }
};

// ── Fact storage ─────────────────────────────────────────────────────────────

const contentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * Dedup-check and store extracted facts in Qdrant.
 * Returns count of facts actually inserted.
 */
const storeFacts = async (
  facts: ExtractedFact[],
  sessionId: string,
  config?: Mem00Config,
): Promise<number> => {
  if (!qdrant.isReady()) {
    logFn("WARN", "Extraction: Qdrant not ready, skipping store");
    return 0;
  }

  const baseMeta: Record<string, string> = { extracted_from_session: sessionId };

  let stored = 0;

  for (const fact of facts) {
    const hash = contentHash(fact.content);

    try {
      const dedup = await qdrant.dedupCheck(fact.content, hash);

      if (dedup.action === "skip") {
        // Reinforce existing fact
        if (dedup.existingId) {
          await qdrant.reinforceFact(dedup.existingId, dedup.existingCount || 1);
        }
        continue;
      }

      // Run contradiction detection for non-trivial facts
      if (config && (fact.confidence ?? 0.5) >= 0.5) {
        try {
          const contradiction = await detectContradiction(fact, config);
          if (contradiction.contradiction && contradiction.existingId) {
            logFn("INFO", `Extraction: contradiction detected for "${fact.content.slice(0, 60)}..." vs ${contradiction.existingId}: ${contradiction.reason}`);
            // Log contradiction instead of writing to inbox
          }
        } catch (e) {
          logFn("WARN", `Extraction: contradiction check failed: ${(e as Error).message}`);
        }
      }

      const storePayload: StoreFact = {
        content: fact.content,
        category: fact.category,
        entities: fact.entities,
        source: "cortex",
        kind: "fact",
        confidence: fact.confidence,
        importance: fact.importance,
        content_hash: hash,
        metadata: baseMeta,
      };

      if (dedup.action === "supersede" && dedup.existingId) {
        const newId = await qdrant.storeFact(storePayload);
        await qdrant.supersedeFact(dedup.existingId, newId);
        stored++;
      } else {
        await qdrant.storeFact(storePayload);
        stored++;
      }
    } catch (e) {
      logFn("WARN", `Extraction: failed to store fact: ${(e as Error).message}`);
    }
  }

  return stored;
};

// ── Tick entry point ─────────────────────────────────────────────────────────

// Max transcript size per LLM call (~60K chars ≈ 15K tokens)
const MAX_TRANSCRIPT_CHARS = 60_000;

/**
 * Periodic extraction tick — called from the daemon tick loop.
 * For each active Copilot session with events.jsonl, reads new events
 * since the last high-water mark, extracts facts via LLM, and stores in Qdrant.
 */
export const tick = async (config: Mem00Config): Promise<void> => {
  if (config.daemon.extract_every_sec === 0) {
    logFn("DEBUG", "Extraction: disabled by config (extract_every_sec=0)");
    return;
  }
  if (!qdrant.isReady()) {
    logFn("DEBUG", "Extraction: Qdrant not ready, skipping");
    return;
  }

  // Respect extract_every_sec at the global level
  const intervalMs = (config.daemon.extract_every_sec || 300) * 1000;
  const now = Date.now();
  if (now - lastTickAt < intervalMs) return;
  lastTickAt = now;

  const minEvents = config.daemon.extract_min_events || 5;

  try {
    // Extract from ALL active Copilot sessions with events.jsonl
    const lockMappings = await resolveLockFiles();
    const aliveMappings = lockMappings.filter(m => isProcessAlive(m.pid));
    logFn("INFO", `Extraction tick: ${aliveMappings.length} active copilot session(s) with events.jsonl`);

    for (const mapping of aliveMappings) {
      await extractForUuid(mapping, minEvents, config);
    }
  } catch (e) {
    logFn("ERROR", `Extraction tick failed: ${(e as Error).message}`);
  }
};

/**
 * Extract facts for a single Copilot session identified by UUID.
 * Uses UUID as the extraction_state key.
 * Automatically chunks large transcripts into multiple LLM calls.
 */
const extractForUuid = async (
  mapping: LockMapping,
  minEvents: number,
  config?: Mem00Config,
): Promise<number> => {
  const { uuid, eventsPath } = mapping;

  // Use UUID as session_id in extraction_state (prefix with "uuid:" to avoid collisions)
  const stateKey = `uuid:${uuid}`;

  let state = getExtractionState(stateKey);
  if (!state) {
    state = {
      session_id: stateKey,
      copilot_uuid: uuid,
      events_path: eventsPath,
      byte_offset: 0,
      last_extracted_at: null,
      event_count: 0,
    };
  }

  // Read new events
  const { events, newOffset, totalLines } = await readNewEvents(eventsPath, state.byte_offset);

  if (events.length < minEvents) {
    // Still update offset to avoid re-scanning non-extractable events
    if (newOffset > state.byte_offset) {
      state.byte_offset = newOffset;
      state.event_count += totalLines;
      upsertExtractionState(state);
    }
    return 0;
  }

  // Chunk events into transcript-sized batches to stay within LLM limits
  const chunks = chunkEvents(events, MAX_TRANSCRIPT_CHARS);
  let totalFacts = 0;

  for (let i = 0; i < chunks.length; i++) {
    const transcript = buildTranscript(chunks[i]!);
    logFn("DEBUG", `Extraction: UUID ${uuid.slice(0, 8)} — chunk ${i + 1}/${chunks.length}, ${chunks[i]!.length} events, ${transcript.length} chars`);
    const facts = await extractFacts(transcript);

    if (facts.length > 0) {
      const stored = await storeFacts(facts, stateKey, config);
      totalFacts += stored;
    }
  }

  if (totalFacts > 0) {
    logFn("INFO", `Extraction: UUID ${uuid.slice(0, 8)} — ${totalFacts} facts stored (${events.length} events, ${chunks.length} chunk(s))`);
  } else {
    logFn("DEBUG", `Extraction: UUID ${uuid.slice(0, 8)} — ${events.length} events but 0 facts extracted`);
  }

  // Update high-water mark
  state.byte_offset = newOffset;
  state.event_count += totalLines;
  state.last_extracted_at = new Date().toISOString();
  state.copilot_uuid = uuid;
  state.events_path = eventsPath;
  upsertExtractionState(state);

  return totalFacts;
};

/**
 * Split events into chunks where each chunk's transcript stays under maxChars.
 */
const chunkEvents = (events: ParsedEvent[], maxChars: number): ParsedEvent[][] => {
  const chunks: ParsedEvent[][] = [];
  let current: ParsedEvent[] = [];
  let currentSize = 0;

  for (const ev of events) {
    const evSize = Math.min(ev.content.length, 2000) + 20; // account for role prefix + newlines
    if (currentSize + evSize > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(ev);
    currentSize += evSize;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
};
