/**
 * Events-based memory extraction — reads Copilot CLI events.jsonl transcripts,
 * extracts facts via LLM, and stores them in Qdrant with source: "daemon".
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
import type { BikkyConfig } from "../config.js";
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

const DEFAULT_EXTRACTION_PROMPT = `You are a knowledge extraction agent for software engineers. Extract ENGINEERING REFERENCES — durable facts that help an engineer navigate codebases, understand infrastructure, run operations, and make decisions.

## Quality Gate (apply to EVERY candidate fact)
A fact must pass AT LEAST ONE of these tests or it is noise — skip it:
1. GREPPABLE — contains a file path, service name, config key, CLI flag, or symbol an engineer could search for
2. RUNNABLE — contains a command, URL, port, or procedure that could be executed
3. NAVIGABLE — tells you where to look for something specific (which repo, which module, which config)
4. DECISIVE — records a choice with enough rationale that a future engineer won't re-debate it

## 7 Reference Types (extract ONLY these)

### 1. Codebase Map — "where does X live?"
File paths, entry points, module ownership, call chains.
GOOD: "Alert extraction logic is in src/enrichers/bank-account-enricher.ts, called by the DM pipeline handler (src/pipeline/dm-handler.ts), not the group handler"
BAD: "The code was updated to fix extraction" (no path, no specifics)

### 2. Architecture Decision — "why was X chosen?"
Choice + alternatives considered + rationale + constraints.
GOOD: "Chose Portkey over direct Bedrock calls for LLM routing — gives per-model fallback chains and spend tracking without vendor lock-in. Decided in PR #847"
BAD: "We use Portkey for LLM" (no rationale, no context)

### 3. Infrastructure Topology — "what connects to what?"
Endpoints, ports, resource IDs, service connections, cluster names, regions.
GOOD: "ClickHouse in lloyds cluster accessed via port-forward: kubectl port-forward svc/clickhouse 9000:9000 --context arn:aws:eks:eu-west-2:871829501674:cluster/lloyds"
BAD: "ClickHouse is running" (no actionable detail)

### 4. Access & Credentials — "how do I authenticate?"
Where secrets live, IAM roles, auth patterns, permission gotchas.
GOOD: "saber IAM user blocked by EnforceMFA for ECR/S3 — use --profile mfa. EC2 instance role agent00-cortex-ec2 has ECR pull+push scoped to arn:aws:ecr:ap-southeast-2:871829501674:repository/agent00-cortex"
BAD: "AWS credentials are configured" (useless)

### 5. Deployment & Shipping — "how do I release X?"
Build, release, CI/CD pipelines, verification steps.
GOOD: "EC2 cortex deploys via SSM: download repo tarball from GitHub API (needs saber-zrelli-private token) → build on EC2 (native amd64) → push to ECR → docker compose pull && up -d. SSM executionTimeout must be ≥600s"
BAD: "The deployment was successful" (not reusable)

### 6. Operational Procedure — "how do I do X on a live system?"
kubectl recipes, patching commands, rollout procedures, scaling ops, cleanup, troubleshooting.
GOOD: "To roll TG bot images across lloyds fleet: kubectl get deploy -l app=tg-bot --context lloyds-ctx, then patch each with image update. Wait 30s between batches to avoid message loss"
BAD: "Bot images were updated" (no procedure)

### 7. Business Logic Rule — "what are the domain rules?"
Data flow semantics, edge cases that affect code, domain-specific constraints.
GOOD: "SA bank accounts (Capitec branch 470010, TymeBank 678910, FNB 250655) are frequently misclassified as AU BSBs because branch codes are 6 digits. Recovery script stage 1b re-extracts with ZA country tagging"
BAD: "Bank accounts are extracted" (no specifics)

## What to ALWAYS SKIP
- Session narration: "the user asked to fix X, then we looked at Y" — that's a log, not a reference
- Meta-observations about tools: "bikky handles extraction" / "the agent used kubectl" — obvious from context
- Debugging state: "test 67 fails" / "got a 404" — transient unless it reveals a PERMANENT quirk
- Vague summaries: "WhatsApp bot was updated" — which bot? which update? which PR?
- Opinions without rationale: "Nova Lite is good" — good for what? compared to what?
- Anything you can't add specifics to: if you can't name a file, service, command, or decision — skip it

## Output format
{"facts": [
  {
    "content": "EC2 cortex has no git installed — deploys download repo tarball via GitHub API (curl -sL -H 'Authorization: token $TOKEN' https://api.github.com/repos/OWNER/REPO/tarball/main) then build locally on EC2",
    "category": "infrastructure",
    "entities": ["ec2", "ecr", "github-api"],
    "confidence": 0.9,
    "importance": 0.8
  }
]}

- Category: infrastructure | decisions | observation | preferences | projects | team
- Entities: lowercase identifiers (service names, tools, repos — things you'd grep for)
- Confidence 0.0-1.0: 0.9 for explicit statements, 0.6 for inferences
- Importance 0.0-1.0: 0.7+ for architecture/infra/access/ops, 0.5-0.7 for decisions/business rules

Prefer fewer, higher-quality facts over many weak ones. 3 good references beat 10 vague observations.
If nothing passes the quality gate, return: {"facts": []}`;

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
 * Strip tool-call narration and boilerplate from assistant messages.
 * Keeps substantive content — decisions, explanations, findings.
 */
const cleanAssistantContent = (content: string): string => {
  const lines = content.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip tool invocation lines
    if (trimmed.startsWith("<function_calls>") || trimmed.startsWith("<invoke") || trimmed.startsWith("<parameter") || trimmed.startsWith("</")) continue;
    // Skip verbose shell output markers
    if (trimmed.startsWith("```") && trimmed.length < 20) continue;
    // Skip empty lines in sequences (collapse whitespace)
    if (!trimmed && kept.length > 0 && !kept[kept.length - 1]!.trim()) continue;
    kept.push(line);
  }

  return kept.join("\n").trim();
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

    let text = ev.content;

    // Clean assistant messages to reduce noise
    if (role === "ASSISTANT") {
      text = cleanAssistantContent(text);
      if (!text) continue; // Skip if nothing substantive remains
    }

    // Truncate very long content
    if (text.length > 3000) {
      text = text.slice(0, 3000) + "…[truncated]";
    }

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
const extractFacts = async (transcript: string, config?: BikkyConfig): Promise<ExtractedFact[]> => {
  if (!transcript.trim()) return [];

  const prompt = config?.daemon.extraction_prompt || DEFAULT_EXTRACTION_PROMPT;

  const result = await chatCompletion({
    messages: [
      { role: "system", content: prompt },
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
    // Strip markdown code fences (```json ... ```) that some models wrap around JSON
    let cleaned = result.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Parse — handle {facts: [...]}, raw array, or single-fact object
    let parsed: unknown = JSON.parse(cleaned);
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
        if (f.importance < 0.5) {
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
  config?: BikkyConfig,
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
        source: "daemon",
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
export const tick = async (config: BikkyConfig): Promise<void> => {
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
  config?: BikkyConfig,
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
    const facts = await extractFacts(transcript, config);

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
