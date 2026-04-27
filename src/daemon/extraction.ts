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
import {
  normalizeCategory,
  normalizeEntities,
  normalizeMemorySubtype,
  validateMemorySubtype,
} from "../mcp/taxonomy.js";
import {
  extractionPrompt,
  EXTRACTION_PROMPT_DESCRIPTOR,
  safeParseJson,
} from "../prompts/index.js";
import {
  CAPTURE_POLICY_VERSION,
  CAPTURE_TRIGGERS,
  DEFAULT_CAPTURE_CONTEXT,
  QUALITY_THRESHOLDS,
  promptVersionForSubtype,
  subtypeForCategory,
} from "./capture-policy.js";
import { shouldSummarizeEvents, updateSessionSummary } from "./session-summary.js";
import { compareSubtype } from "./extraction-rules.js";

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

export const DEFAULT_EXTRACTION_PROMPT = `You are Bikky's memory extraction agent for open-source coding agents. Extract durable, reusable facts that help a future agent continue work without rereading the whole transcript.

## Core rule
Extract fewer, sharper memories. A candidate fact must be independently useful after the session is gone.

## Quality gate
Every fact must pass at least one gate:
1. GREPPABLE: names a file path, package, symbol, config key, CLI flag, issue/PR, service, or API a future agent can search for.
2. RUNNABLE: contains a command, URL, setting, port, or procedure that can be executed or checked.
3. NAVIGABLE: tells a future agent where to look and what that location means.
4. DECISIVE: records a durable decision, rationale, constraint, convention, or preference.
5. DIAGNOSTIC: captures a repeatable failure mode, root cause, or troubleshooting gotcha.

## Ontology
- domain is the activity profile. For coding-agent captures use "software_engineering".
- category is subject matter: codebase | infrastructure | operations | decisions | product_domain | projects | people | preferences | observations.
- kind is object shape. For this prompt, emit only kind="fact".
- memory_subtype must be one of:
  codebase_map | architecture_decision | infra_topology | access_pattern | operational_procedure | domain_rule | troubleshooting_gotcha | preference.

## Examples
GOOD:
- "The UI smoke tests live in packages/ui/tests/smoke.spec.ts and run through npm run test:e2e with mocked /api/memory/* responses."
- "Use workspace_id as the tenancy/access boundary; domain is reserved for activity profile such as software_engineering."
- "If Qdrant order_by fails with a missing index error, create a datetime payload index for the sorted field before retrying."
- "Prefer Node's built-in test runner for root tests; do not add Jest just for daemon unit tests."

BAD:
- "The tests were fixed." (status only)
- "We reviewed the code." (session narration)
- "The deployment succeeded." (transient and not reusable)
- "The agent used npm." (tool narration)
- "There was an error." (no root cause or reusable detail)

## Output format
Return strict JSON:
{"facts":[
  {
    "content":"One self-contained durable fact.",
    "category":"codebase",
    "memory_subtype":"codebase_map",
    "entities":["repo-or-tool","specific-module"],
    "confidence":0.9,
    "importance":0.7,
    "quality_score":0.8,
    "confidence_reason":"Explicitly stated in the transcript.",
    "repo":"optional/repo-or-package",
    "branch":"optional-branch",
    "task_key":"optional issue/PR/task key",
    "workstream_key":"optional stable workstream key"
  }
]}

Scoring:
- confidence: 0.9 explicit, 0.7 strong inference, 0.55 weak but useful inference.
- importance: 0.8+ for decisions, infra, procedures, access, recurring failures; 0.6+ for useful codebase maps/preferences.
- quality_score: 0.8+ passes multiple gates, 0.6+ passes one strong gate, below 0.6 should usually be omitted.

If nothing passes the quality gate, return {"facts":[]}.`;

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

export type Volatility = "stable" | "evolving" | "transient" | "ephemeral";

const VOLATILITY_VALUES: ReadonlySet<Volatility> = new Set([
  "stable",
  "evolving",
  "transient",
  "ephemeral",
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ExtractedFact {
  content: string;
  category: string;
  memory_subtype?: string | null;
  subtype_reason?: string | null;
  entities: string[];
  confidence: number;
  importance: number;
  quality_score?: number | null;
  confidence_reason?: string | null;
  repo?: string | null;
  branch?: string | null;
  task_key?: string | null;
  workstream_key?: string | null;
  // Self-judgment fields (prompt v2026-04-28-1+)
  subject?: string | null;
  subject_specificity?: number | null;
  volatility?: Volatility | null;
  volatility_reason?: string | null;
  self_contained?: boolean | null;
  as_of?: string | null;
}

export interface FactQualitySignals {
  wordCount: number;
  hasDurableAnchor: boolean;
  isStatusOnly: boolean;
  isShortUseful: boolean;
  computedQualityScore: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const textWordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

const hasDurableAnchor = (content: string, entities: string[]): boolean => {
  const text = content.trim();
  return Boolean(
    /(?:^|\s)(?:[\w.-]+\/)+[\w./-]+/.test(text) ||
    /`[^`]+`/.test(text) ||
    /\b(?:npm|pnpm|yarn|node|git|gh|docker|kubectl|make|go|python|pip|cargo|terraform|aws|curl)\b/.test(text) ||
    /https?:\/\/\S+/.test(text) ||
    /\b[A-Z][A-Z0-9_]{2,}\b/.test(text) ||
    /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|json|ya?ml|toml|md|sql|sh)\b/.test(text) ||
    /\b(?:issue|pr|pull request)\s*#?\d+\b/i.test(text) ||
    entities.length >= 2,
  );
};

const isStatusOnlyContent = (content: string, entities: string[]): boolean => {
  const lower = content.trim().toLowerCase();
  if (hasDurableAnchor(content, entities)) return false;
  if (textWordCount(content) > 16) return false;
  return /\b(done|fixed|updated|implemented|reviewed|tested|works|passed|failed|succeeded|completed|started|looked|changed|deployed)\b/.test(lower);
};

export const factQualitySignals = (fact: ExtractedFact): FactQualitySignals => {
  const content = fact.content.trim();
  const entities = normalizeEntities(fact.entities ?? []);
  const subtype = normalizeMemorySubtype("fact", fact.memory_subtype) ?? subtypeForCategory(normalizeCategory(fact.category));
  const wordCount = textWordCount(content);
  const durableAnchor = hasDurableAnchor(content, entities);
  const statusOnly = isStatusOnlyContent(content, entities);
  const isPreferenceLike = subtype === "preference" || subtype === "domain_rule";
  const isDecisionLike = subtype === "architecture_decision" || subtype === "troubleshooting_gotcha";
  const shortUseful = wordCount >= 7 && wordCount <= 22 && (isPreferenceLike || isDecisionLike) && (entities.length > 0 || durableAnchor);

  let score = 0.25;
  if (wordCount >= 8) score += 0.1;
  if (wordCount >= 14) score += 0.1;
  if (durableAnchor) score += 0.25;
  if (isPreferenceLike || isDecisionLike) score += 0.15;
  if ((fact.confidence ?? 0) >= 0.75) score += 0.1;
  if ((fact.importance ?? 0) >= 0.7) score += 0.1;
  if (statusOnly) score -= 0.4;

  // Phase 1: fold the LLM's self-judged subject_specificity into the score so
  // the verifier in Phase 2 can act on it. The verifier itself remains the
  // structural backstop — this is just a smooth signal.
  if (typeof fact.subject_specificity === "number") {
    if (fact.subject_specificity >= 0.7) score += 0.1;
    else if (fact.subject_specificity < 0.3) score -= 0.2;
  }
  if (fact.self_contained === false) score -= 0.15;

  return {
    wordCount,
    hasDurableAnchor: durableAnchor,
    isStatusOnly: statusOnly,
    isShortUseful: shortUseful,
    computedQualityScore: Math.round(clamp01(score) * 100) / 100,
  };
};

export const normalizeExtractedFact = (raw: Record<string, unknown>): ExtractedFact | null => {
  if (!raw.content || typeof raw.content !== "string") return null;

  const category = normalizeCategory(typeof raw.category === "string" ? raw.category : "observations");
  const requestedSubtype = typeof raw.memory_subtype === "string" ? raw.memory_subtype : null;
  let memorySubtype = requestedSubtype ? normalizeMemorySubtype("fact", requestedSubtype) : null;
  if (!memorySubtype) {
    memorySubtype = subtypeForCategory(category);
  }

  try {
    validateMemorySubtype("fact", memorySubtype);
  } catch {
    memorySubtype = subtypeForCategory(category);
  }

  const confidence = typeof raw.confidence === "number" ? clamp01(raw.confidence) : 0.7;
  const importance = typeof raw.importance === "number" ? clamp01(raw.importance) : 0.5;
  const qualityScore = typeof raw.quality_score === "number" ? clamp01(raw.quality_score) : null;
  const entities = Array.isArray(raw.entities)
    ? normalizeEntities(raw.entities.map((entity) => String(entity)))
    : [];

  // Self-judgment fields (prompt v2026-04-28-1+)
  const subject = typeof raw.subject === "string" && raw.subject.trim().length > 0
    ? raw.subject.trim()
    : null;
  const subjectSpecificity = typeof raw.subject_specificity === "number"
    ? clamp01(raw.subject_specificity)
    : null;
  const rawVolatility = typeof raw.volatility === "string" ? raw.volatility.trim().toLowerCase() : null;
  const volatility: Volatility | null = rawVolatility && VOLATILITY_VALUES.has(rawVolatility as Volatility)
    ? (rawVolatility as Volatility)
    : null;
  const volatilityReason = typeof raw.volatility_reason === "string" && raw.volatility_reason.trim().length > 0
    ? raw.volatility_reason.trim()
    : null;
  const selfContained = typeof raw.self_contained === "boolean" ? raw.self_contained : null;
  const rawAsOf = typeof raw.as_of === "string" ? raw.as_of.trim() : null;
  const asOf = rawAsOf && ISO_DATE_RE.test(rawAsOf) ? rawAsOf : null;

  const fact: ExtractedFact = {
    content: raw.content.trim(),
    category,
    memory_subtype: memorySubtype,
    subtype_reason: typeof raw.subtype_reason === "string" ? raw.subtype_reason.trim() : null,
    entities,
    confidence,
    importance,
    quality_score: qualityScore,
    confidence_reason: typeof raw.confidence_reason === "string" ? raw.confidence_reason.trim() : null,
    repo: typeof raw.repo === "string" && raw.repo.trim().length > 0 ? raw.repo.trim() : null,
    branch: typeof raw.branch === "string" ? raw.branch.trim() : null,
    task_key: typeof raw.task_key === "string" ? raw.task_key.trim() : null,
    workstream_key: typeof raw.workstream_key === "string" ? raw.workstream_key.trim() : null,
    subject,
    subject_specificity: subjectSpecificity,
    volatility,
    volatility_reason: volatilityReason,
    self_contained: selfContained,
    as_of: asOf,
  };

  return isHighQualityExtractedFact(fact) ? fact : null;
};

export const isHighQualityExtractedFact = (fact: ExtractedFact): boolean => {
  const content = fact.content.trim();
  if (content.length < 30) return false;

  const signals = factQualitySignals(fact);
  if (QUALITY_THRESHOLDS.rejectStatusOnlyFacts && signals.isStatusOnly) return false;

  const confidence = fact.confidence ?? 0.7;
  const importance = fact.importance ?? 0.5;
  if (confidence < QUALITY_THRESHOLDS.minFactConfidence && importance < QUALITY_THRESHOLDS.minImportanceForLowConfidenceFact) {
    return false;
  }

  const qualityScore = fact.quality_score ?? signals.computedQualityScore;
  if (qualityScore < QUALITY_THRESHOLDS.minFactQualityScore && !signals.isShortUseful) return false;
  if (!signals.hasDurableAnchor && !signals.isShortUseful) return false;

  return true;
};

/**
 * Call the LLM to extract facts from a conversation transcript.
 */
const extractFacts = async (transcript: string, config?: BikkyConfig): Promise<ExtractedFact[]> => {
  if (!transcript.trim()) return [];

  const rendered = extractionPrompt({
    transcript,
    systemOverride: config?.daemon.extraction_prompt ?? null,
  });

  const result = await chatCompletion(rendered);

  if (!result) {
    logFn("WARN", "Extraction LLM call returned null");
    return [];
  }

  // Parse — handle {facts: [...]}, raw array, or single-fact object
  let parsed: unknown = safeParseJson<unknown>(result);
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
    .map((raw) => {
      const fact = normalizeExtractedFact(raw);
      if (!fact) {
        const content = typeof raw.content === "string" ? raw.content : JSON.stringify(raw).slice(0, 120);
        logFn("DEBUG", `Extraction: dropping low-quality fact candidate: "${content.slice(0, 80)}…"`);
        return null;
      }
      return fact;
    })
    .filter((fact): fact is ExtractedFact => fact !== null);
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

  const baseMeta: Record<string, string | number | boolean | null> = {
    extracted_from_session: sessionId,
    capture_policy_version: CAPTURE_POLICY_VERSION,
    extracted_by_prompt: `${EXTRACTION_PROMPT_DESCRIPTOR.id}@${EXTRACTION_PROMPT_DESCRIPTOR.version}`,
  };
  let stored = 0;

  for (const fact of facts) {
    const hash = contentHash(fact.content);
    const sanitizedFact: ExtractedFact = {
      ...fact,
      entities: fact.entities.map((entity) => entity.toLowerCase()),
    };

    try {
      const dedup = await qdrant.dedupCheck(sanitizedFact.content, hash);

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
          const contradiction = await detectContradiction(sanitizedFact, config);
          if (contradiction.contradiction && contradiction.existingId) {
            logFn("INFO", `Extraction: contradiction detected for "${fact.content.slice(0, 60)}..." vs ${contradiction.existingId}: ${contradiction.reason}`);
            // Log contradiction instead of writing to inbox
          }
        } catch (e) {
          logFn("WARN", `Extraction: contradiction check failed: ${(e as Error).message}`);
        }
      }

      const subtype = validateMemorySubtype("fact", sanitizedFact.memory_subtype)
        ?? subtypeForCategory(normalizeCategory(sanitizedFact.category));

      // Verifier: rule-table check on subtype. If rule table is confident in
      // a *different* subtype with a margin >= 0.6, treat the LLM as suspect:
      // keep its choice (LLM is still source of truth) but lower confidence
      // and stash the disagreement in metadata for human review.
      const subtypeAgreement = compareSubtype(sanitizedFact.content, subtype);
      const factMeta: Record<string, string | number | boolean | null> = { ...baseMeta };
      let effectiveConfidence = fact.confidence;
      if (sanitizedFact.subtype_reason) {
        factMeta.subtype_reason = sanitizedFact.subtype_reason;
      }
      if (subtypeAgreement.verdict === "disagree" && subtypeAgreement.ruleSubtype) {
        factMeta.subtype_rule_disagreement = subtypeAgreement.ruleSubtype;
        factMeta.subtype_rule_margin = Math.round(subtypeAgreement.margin * 100) / 100;
        effectiveConfidence = clamp01(effectiveConfidence - 0.15);
      }

      // Phase 1: persist self-judgment fields in metadata. The Phase 2 verifier
      // wires these into structural decisions (downgrade, expiry, category force).
      if (sanitizedFact.subject) factMeta.subject = sanitizedFact.subject;
      if (typeof sanitizedFact.subject_specificity === "number") {
        factMeta.subject_specificity = Math.round(sanitizedFact.subject_specificity * 100) / 100;
      }
      if (sanitizedFact.volatility_reason) factMeta.volatility_reason = sanitizedFact.volatility_reason;
      if (typeof sanitizedFact.self_contained === "boolean") {
        factMeta.self_contained = sanitizedFact.self_contained;
      }

      const storePayload: StoreFact = {
        content: sanitizedFact.content,
        category: sanitizedFact.category,
        domain: DEFAULT_CAPTURE_CONTEXT.domain,
        memory_subtype: subtype,
        entities: sanitizedFact.entities,
        source: "daemon",
        kind: "fact",
        confidence: effectiveConfidence,
        importance: fact.importance,
        content_hash: hash,
        prompt_version: promptVersionForSubtype(subtype),
        capture_policy_version: CAPTURE_POLICY_VERSION,
        quality_score: fact.quality_score ?? factQualitySignals(fact).computedQualityScore,
        confidence_reason: fact.confidence_reason,
        review_status: DEFAULT_CAPTURE_CONTEXT.reviewStatus,
        volatility: DEFAULT_CAPTURE_CONTEXT.volatility,
        repo: fact.repo,
        branch: fact.branch,
        task_key: fact.task_key,
        workstream_key: fact.workstream_key,
        metadata: factMeta,
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

const updateSummaryForTranscript = async (
  sessionId: string,
  transcript: string,
  eventCount: number,
  config?: BikkyConfig,
): Promise<void> => {
  try {
    const result = await updateSessionSummary({ sessionId, transcript, eventCount, config });
    if (result.action === "stored" || result.action === "updated") {
      logFn("INFO", `Summary: ${result.action} session summary ${result.factId} for ${sessionId}`);
    } else {
      logFn("DEBUG", `Summary: skipped for ${sessionId} (${result.reason})`);
    }
  } catch (e) {
    logFn("WARN", `Summary: failed for ${sessionId}: ${(e as Error).message}`);
  }
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

  const minEvents = config.daemon.extract_min_events || CAPTURE_TRIGGERS.factExtraction.minEvents;

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

  const shouldSummarize = shouldSummarizeEvents(events, minEvents);

  if (events.length < minEvents && !shouldSummarize) {
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

    if (events.length >= minEvents) {
      const facts = await extractFacts(transcript, config);

      if (facts.length > 0) {
        const stored = await storeFacts(facts, stateKey, config);
        totalFacts += stored;
      }
    }

    await updateSummaryForTranscript(stateKey, transcript, chunks[i]!.length, config);
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
