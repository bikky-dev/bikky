/**
 * Daemon-Driven Memory Consolidation
 *
 * Periodic maintenance tasks that keep memory lean and accurate:
 * - Auto-distillation: consolidate session summaries into patterns
 * - Contradiction detection: find and resolve conflicting facts
 * - Category rebalancing: consolidate oversized categories
 * - Decay scoring: downrank stale, unreferenced facts
 * - Health report: generate a memory health report
 * - Memory brief: generate a compact orientation doc from top facts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import * as qdrant from "./qdrant.js";
import { chatCompletion } from "../llm/index.js";
import { categoryValues, normalizeCategory, normalizeDomain } from "../mcp/taxonomy.js";
import {
  distillPrompt,
  DISTILL_PROMPT_DESCRIPTOR,
  contradictionPrompt,
  briefPrompt,
  BRIEF_PROMPT_DESCRIPTOR,
  ALLOWED_BRIEF_HEADINGS,
  safeParseJson,
} from "../prompts/index.js";
import { STATE_DIR } from "../config.js";
import type { BikkyConfig } from "../config.js";
import type { LogFn, QdrantPayload, StoreFact } from "./qdrant.js";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

export interface DistillResult {
  distilled: boolean;
  count?: number;
}

export interface ContradictionResult {
  contradiction: boolean;
  existingId?: string;
  existingContent?: string;
  reason?: string;
}

export interface RebalanceResult {
  rebalanced: boolean;
  category?: string;
  factCount?: number;
  threshold?: number;
  needsAttention?: boolean;
}

export interface HealthReport {
  total: number;
  byCategory: Record<string, number>;
  daemonExtracted: number;
  addedThisWeek: number;
  generatedAt: string;
}

export interface ConsolidationTickOptions {
  postHealthFn?: ((text: string) => Promise<void>) | null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const CATEGORIES: string[] = categoryValues();

let logFn: LogFn = () => {};
const setLogger = (fn: LogFn): void => { logFn = fn; };

const MEMORY_BRIEF_PATH = join(STATE_DIR, "brief.md");

// ─── P3.1 Auto-Distillation ──────────────────────────────────────────────

/**
 * Check for undistilled session summaries and consolidate them.
 * Triggered periodically from daemon tick.
 */
const autoDistill = async (
  _config: BikkyConfig,
  { minSummaries = 5 }: { minSummaries?: number } = {},
): Promise<DistillResult> => {
  if (!qdrant.isReady()) return { distilled: false };

  try {
    // Find undistilled session summaries (support both legacy and new taxonomy)
    const legacyFilter = {
      must: [
        { key: "category", match: { value: "session_summary" } },
        { is_null: { key: "superseded_by" } },
      ],
    };
    const newFilter = {
      must: [
        { key: "kind", match: { value: "summary" } },
        { is_null: { key: "superseded_by" } },
      ],
    };

    type ScrollResponse = { result?: { points?: Array<{ id: string; payload?: QdrantPayload }> } };

    const [legacyRes, newRes] = await Promise.all([
      qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/scroll`, {
        filter: legacyFilter, limit: 50, with_payload: true,
      }) as Promise<ScrollResponse>,
      qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/scroll`, {
        filter: newFilter, limit: 50, with_payload: true,
      }) as Promise<ScrollResponse>,
    ]);

    // Deduplicate by ID
    const seen = new Set<string>();
    const points: Array<{ id: string; payload?: QdrantPayload }> = [];
    for (const pt of [...(legacyRes.result?.points || []), ...(newRes.result?.points || [])]) {
      if (!seen.has(pt.id)) {
        seen.add(pt.id);
        points.push(pt);
      }
    }
    if (points.length < minSummaries) {
      return { distilled: false, count: points.length };
    }

    // Sort by date — newest first (recent patterns are more actionable)
    points.sort((a, b) => (b.payload?.created_at || "").localeCompare(a.payload?.created_at || ""));

    // Take the latest batch (up to 20)
    const batch = points.slice(0, 20);

    const rendered = distillPrompt({
      summaries: batch.map((pt, i) => ({
        id: i + 1,
        date: (pt.payload?.created_at as string | undefined)?.slice(0, 10) ?? "unknown",
        content: (pt.payload?.content as string | undefined) ?? "",
      })),
    });

    const raw = await chatCompletion({
      ...rendered,
      telemetry: { subsystem: "distillation", trigger: "auto_distill" },
    });

    if (!raw) {
      logFn("WARN", "Auto-distill LLM returned empty");
      return { distilled: false };
    }

    const parsed = safeParseJson<{
      patterns?: Array<{
        content?: string;
        category?: string;
        domain?: string;
        entities?: string[];
        importance?: number;
        evidence_summary_ids?: number[];
      }>;
    } | Array<{ content?: string; entities?: string[]; importance?: number }>>(raw);

    let patterns: Array<{
      content?: string;
      category?: string;
      domain?: string;
      entities?: string[];
      importance?: number;
    }> = [];
    if (Array.isArray(parsed)) {
      patterns = parsed;
    } else if (parsed && Array.isArray(parsed.patterns)) {
      patterns = parsed.patterns;
    }

    if (patterns.length === 0) return { distilled: false };

    const promptStamp = `${DISTILL_PROMPT_DESCRIPTOR.id}@${DISTILL_PROMPT_DESCRIPTOR.version}`;

    // Store distilled patterns
    for (const pattern of patterns) {
      if (!pattern.content) continue;
      const hash = createHash("sha256").update(`distilled:${pattern.content}`).digest("hex");
      await qdrant.storeFact({
        content: pattern.content,
        category: normalizeCategory(pattern.category ?? "observation"),
        domain: normalizeDomain(pattern.domain ?? "work"),
        kind: "distilled",
        entities: Array.isArray(pattern.entities) ? pattern.entities.map(e => String(e).toLowerCase()) : [],
        source: "system",
        confidence: 0.85,
        importance: pattern.importance || 0.7,
        content_hash: hash,
        metadata: {
          distilled_from: batch.length.toString(),
          distilled_at: new Date().toISOString(),
          distilled_by_prompt: promptStamp,
        },
      });
    }

    // Supersede the source summaries
    for (const pt of batch) {
      await qdrant.supersedeFact(pt.id, `distilled:${new Date().toISOString()}`);
    }

    logFn("INFO", `Auto-distill: consolidated ${batch.length} summaries into ${patterns.length} patterns`);
    return { distilled: true, count: patterns.length };
  } catch (e) {
    logFn("ERROR", `Auto-distill failed: ${(e as Error).message}`);
    return { distilled: false };
  }
};

// ─── P3.2 Contradiction Detection ────────────────────────────────────────

/**
 * Check a newly extracted fact for contradictions with existing facts.
 * Called during extraction for high-importance facts.
 */
const detectContradiction = async (
  fact: { content: string; category: string; entities: string[]; importance?: number },
  _config: BikkyConfig,
  telemetry?: { sessionId?: string; workstreamKey?: string },
): Promise<ContradictionResult> => {
  if (!qdrant.isReady()) return { contradiction: false };
  if ((fact.importance || 0) < 0.3) return { contradiction: false };

  try {
    const vector = await qdrant.embed(fact.content);
    // Search across ALL categories — contradictions can cross category lines
    // (e.g. an "infrastructure" port fact vs an "observation" workaround fact).
    const results = await qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/search`, {
      vector,
      filter: { must: [{ is_null: { key: "superseded_by" } }] },
      limit: 5,
      with_payload: true,
    });

    const candidates = ((results.result || []) as Array<{ id: string; score: number; payload?: QdrantPayload }>)
      .filter(r => r.score >= 0.75 && r.score < 0.92);
    if (candidates.length === 0) return { contradiction: false };

    const rendered = contradictionPrompt({
      newFact: { content: fact.content, category: fact.category },
      candidates: candidates.map((c) => ({
        id: c.id,
        content: (c.payload?.content as string | undefined) ?? "",
        category: (c.payload?.category as string | undefined) ?? "unknown",
        score: c.score,
      })),
    });

    const raw = await chatCompletion({
      ...rendered,
      telemetry: {
        subsystem: "contradiction",
        ...(telemetry?.sessionId ? { session_id: telemetry.sessionId } : {}),
        ...(telemetry?.workstreamKey ? { workstream_key: telemetry.workstreamKey } : {}),
        trigger: "fact_contradiction_check",
      },
    });
    if (!raw) return { contradiction: false };

    const result = safeParseJson<{
      outcome?: "compatible" | "superseded" | "contradicted";
      existing_id?: string;
      reason?: string;
      // Back-compat: older deployments may still emit {"contradiction": true}
      contradiction?: boolean;
    }>(raw);

    if (!result) return { contradiction: false };

    const outcome = result.outcome
      ?? (result.contradiction === true ? "contradicted" : "compatible");

    if (outcome === "compatible") return { contradiction: false };

    if (outcome === "superseded" && result.existing_id) {
      // Auto-resolve: caller (extraction) marks the old fact superseded via
      // qdrant dedup machinery; here we just signal it's not a contradiction.
      logFn(
        "INFO",
        `Supersede detected: "${fact.content.slice(0, 60)}…" → existing ${result.existing_id} (${result.reason ?? ""})`,
      );
      return { contradiction: false };
    }

    if (outcome === "contradicted" && result.existing_id) {
      const existing = candidates.find((c) => c.id === result.existing_id);
      logFn("INFO", `Contradiction detected: "${fact.content}" vs existing ${result.existing_id}: ${result.reason ?? ""}`);
      return {
        contradiction: true,
        existingId: result.existing_id,
        existingContent: existing?.payload?.content as string | undefined,
        reason: result.reason,
      };
    }

    return { contradiction: false };
  } catch (e) {
    logFn("WARN", `Contradiction detection failed: ${(e as Error).message}`);
    return { contradiction: false };
  }
};

// ─── P3.3 Category Rebalancing ───────────────────────────────────────────

/**
 * Check for oversized categories and consolidate them.
 */
const rebalanceCategories = async (
  _config: BikkyConfig,
  threshold = 100,
  postFn?: ((text: string) => Promise<void>) | null,
): Promise<RebalanceResult> => {
  if (!qdrant.isReady()) return { rebalanced: false };

  const categories = CATEGORIES;
  const oversized: Array<{ category: string; count: number }> = [];
  try {
    for (const category of categories) {
      const count = await qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/count`, {
        filter: {
          must: [
            { key: "category", match: { value: category } },
            { is_null: { key: "superseded_by" } },
          ],
        },
        exact: true,
      });

      const factCount = (count.result as { count?: number })?.count || 0;
      if (factCount > threshold) {
        oversized.push({ category, count: factCount });
      }
    }

    if (oversized.length === 0) return { rebalanced: false };

    const lines = oversized.map(o => `  • ${o.category}: ${o.count} facts (threshold: ${threshold})`);
    const message = `⚠️ Memory Rebalance Alert\n\nOversized categories:\n${lines.join("\n")}\n\nConsider consolidating or archiving older facts.`;
    logFn("INFO", `Rebalance: ${oversized.length} oversized categories detected`);

    if (postFn) {
      postFn(message).catch(() => { /* noop */ });
    }

    return { rebalanced: false, category: oversized[0]!.category, factCount: oversized[0]!.count, threshold, needsAttention: true };
  } catch (e) {
    logFn("WARN", `Category rebalancing check failed: ${(e as Error).message}`);
    return { rebalanced: false };
  }
};

// ─── P3.5 Memory Health Report ───────────────────────────────────────────

/**
 * Generate a memory health report.
 */
const generateHealthReport = async (): Promise<HealthReport | null> => {
  if (!qdrant.isReady()) return null;

  try {
    const categories = [...CATEGORIES];
    const stats: Record<string, number> = {};
    let total = 0;

    for (const cat of categories) {
      const count = await qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/count`, {
        filter: {
          must: [
            { key: "category", match: { value: cat } },
            { is_null: { key: "superseded_by" } },
          ],
        },
        exact: true,
      });
      stats[cat] = (count.result as { count?: number })?.count || 0;
      total += stats[cat]!;
    }

    // Count by kind
    for (const kind of ["summary", "distilled", "relation"]) {
      const count = await qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/count`, {
        filter: {
          must: [
            { key: "kind", match: { value: kind } },
            { is_null: { key: "superseded_by" } },
          ],
        },
        exact: true,
      });
      stats[kind] = (count.result as { count?: number })?.count || 0;
    }

    // Count daemon-extracted
    const daemonCount = await qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/count`, {
      filter: {
        must: [
          { key: "source", match: { value: "daemon" } },
          { is_null: { key: "superseded_by" } },
        ],
      },
      exact: true,
    });

    // Count facts added in last 7 days
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentCount = await qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/count`, {
      filter: {
        must: [
          { key: "created_at", range: { gte: weekAgo } },
          { is_null: { key: "superseded_by" } },
        ],
      },
      exact: true,
    });

    return {
      total,
      byCategory: stats,
      daemonExtracted: (daemonCount.result as { count?: number })?.count || 0,
      addedThisWeek: (recentCount.result as { count?: number })?.count || 0,
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    logFn("ERROR", `Health report generation failed: ${(e as Error).message}`);
    return null;
  }
};

/**
 * Format health report as a readable string.
 */
const formatHealthReport = (report: HealthReport | null): string => {
  if (!report) return "Memory health report unavailable";

  const lines = [
    `Memory Health Report — ${new Date(report.generatedAt).toLocaleDateString()}`,
    "",
    `Total facts: ${report.total}`,
    `Added this week: ${report.addedThisWeek}`,
    `Daemon-extracted: ${report.daemonExtracted}`,
    "",
    "By category:",
  ];

  for (const [cat, count] of Object.entries(report.byCategory)) {
    const bar = "█".repeat(Math.min(20, Math.ceil(count / 5)));
    lines.push(`  ${cat}: ${count} ${bar}`);
  }

  return lines.join("\n");
};

// ─── P3.6 Compact Memory Brief ──────────────────────────────────────────

/**
 * Generate a compact memory brief from top facts.
 * Written to ~/.bikky/state/brief.md for agent orientation.
 */
const CATEGORY_TO_HEADING: Record<string, (typeof ALLOWED_BRIEF_HEADINGS)[number]> = {
  team: "Key People & Team",
  people: "Key People & Team",
  projects: "Active Projects",
  infrastructure: "Infrastructure Overview",
  decisions: "Recent Decisions",
  observation: "Known Gotchas",
  observations: "Known Gotchas",
  preferences: "Preferences & Conventions",
};

const generateMemoryBrief = async (_config: BikkyConfig): Promise<boolean> => {
  if (!qdrant.isReady()) return false;

  try {
    // Fetch top facts from each category (importance-weighted)
    const sections: Partial<Record<(typeof ALLOWED_BRIEF_HEADINGS)[number], string[]>> = {};
    const categories = CATEGORIES;

    for (const cat of categories) {
      const heading = CATEGORY_TO_HEADING[cat];
      if (!heading) continue;
      const result = await qdrant.qdrantRequest("POST", `/collections/${qdrant.collection}/points/scroll`, {
        filter: {
          must: [
            { key: "category", match: { value: cat } },
            { is_null: { key: "superseded_by" } },
          ],
        },
        limit: 30,
        with_payload: true,
      }) as { result?: { points?: Array<{ payload?: QdrantPayload }> } };

      const points = (result.result?.points || [])
        .sort((a, b) => (b.payload?.importance || 0) - (a.payload?.importance || 0))
        .slice(0, 10);

      if (points.length > 0) {
        const existing = sections[heading] ?? [];
        const newOnes = points.map(pt => pt.payload?.content).filter(Boolean) as string[];
        sections[heading] = [...existing, ...newOnes];
      }
    }

    if (Object.keys(sections).length === 0) return false;

    const generatedAt = new Date().toISOString().slice(0, 10);
    const rendered = briefPrompt({ generatedAt, sections });
    const brief = await chatCompletion({
      ...rendered,
      telemetry: { subsystem: "brief", trigger: "memory_brief" },
    });

    if (!brief) return false;

    // Stamp the prompt version as a comment so we know which prompt produced
    // a given on-disk brief (debugging aid; ignored by markdown renderers).
    const promptStamp = `${BRIEF_PROMPT_DESCRIPTOR.id}@${BRIEF_PROMPT_DESCRIPTOR.version}`;
    const output = `<!-- generated by ${promptStamp} -->\n${brief}\n`;

    // Write to disk
    mkdirSync(dirname(MEMORY_BRIEF_PATH), { recursive: true });
    writeFileSync(MEMORY_BRIEF_PATH, output, "utf8");
    logFn("INFO", `Memory brief generated: ${MEMORY_BRIEF_PATH} (${brief.length} chars)`);
    return true;
  } catch (e) {
    logFn("ERROR", `Memory brief generation failed: ${(e as Error).message}`);
    return false;
  }
};

// ─── Consolidation Tick ──────────────────────────────────────────────────

// Counters for periodic tasks
let consolidationTickCount = 0;

/**
 * Main consolidation tick — called from daemon tick loop.
 * Spreads out expensive operations across different tick intervals.
 */
const tick = async (config: BikkyConfig, opts: ConsolidationTickOptions = {}): Promise<void> => {
  if (!qdrant.isReady()) return;
  if (config.daemon.consolidation_enabled === false) return;
  consolidationTickCount++;

  // Auto-distillation: every ~100 ticks (500s = ~8 min)
  if (consolidationTickCount % 100 === 0) {
    await autoDistill(config).catch(e =>
      logFn("ERROR", `Auto-distill tick failed: ${(e as Error).message}`)
    );
  }

  // Category rebalancing check: every ~500 ticks (2500s = ~40 min)
  if (consolidationTickCount % 500 === 0) {
    await rebalanceCategories(config, 100, opts.postHealthFn).catch(e =>
      logFn("ERROR", `Category rebalance tick failed: ${(e as Error).message}`)
    );
  }

  // Memory brief regeneration: every ~2000 ticks (10000s = ~2.7 hours)
  if (consolidationTickCount % 2000 === 0) {
    await generateMemoryBrief(config).catch(e =>
      logFn("ERROR", `Memory brief tick failed: ${(e as Error).message}`)
    );
  }

  // Health report: every ~5000 ticks (25000s = ~7 hours)
  if (consolidationTickCount % 5000 === 0 && opts.postHealthFn) {
    const report = await generateHealthReport().catch(() => null);
    if (report) {
      const text = formatHealthReport(report);
      opts.postHealthFn(text).catch(() => { /* noop */ });
    }
  }
};

/** Reset state (for testing). */
const _reset = (): void => {
  consolidationTickCount = 0;
};

export {
  detectContradiction,
  tick,
  setLogger,
  _reset,
};
