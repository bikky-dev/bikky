/**
 * Daemon-owned capture policy for the memory ontology.
 *
 * These constants define when Bikky should capture memory, how large each
 * generated object should be, and which prompt/capture versions are stored on
 * payloads for later audits and prompt evolution.
 */

import type { Category, Kind, MemorySubtype } from "../mcp/taxonomy.js";
import { DEFAULT_DOMAIN } from "../mcp/taxonomy.js";

export const CAPTURE_POLICY_VERSION = "capture-policy-v2";

export const PROMPT_VERSIONS = {
  factExtraction: "fact-extraction-v2",
  sessionIndex: "session-index-v1",
  episodeSummary: "episode-summary-v1",
  workstreamSummary: "workstream-summary-v1",
  distillation: "distillation-v1",
} as const;

export const CAPTURE_TRIGGERS = {
  factExtraction: {
    minEvents: 10,
    minUsefulCharacters: 280,
    maxEventsPerBatch: 120,
    cooldownSeconds: 300,
  },
  episodeSummary: {
    minEvents: 12,
    minUsefulCharacters: 600,
    maxEventsPerEpisode: 80,
    idleGapMinutes: 20,
    forceCheckpointEvents: 140,
  },
  sessionIndex: {
    minEvents: 1,
    forceCheckpointEvents: 140,
    maxRecentEpisodeRefs: 12,
  },
  workstreamSummary: {
    minEpisodeCount: 1,
    minConfidence: 0.65,
    maxEpisodesPerUpdate: 8,
  },
  distillation: {
    minSourceSummaries: 5,
    maxSourceSummaries: 20,
    lookbackDays: 14,
  },
} as const;

export const CAPTURE_BUDGETS = {
  fact: {
    maxFactsPerBatch: 6,
    targetWords: [12, 45],
    maxEntities: 8,
  },
  episodeSummary: {
    targetWords: [90, 180],
    maxTasks: 8,
    maxDecisions: 8,
    maxOpenQuestions: 6,
  },
  sessionIndex: {
    targetWords: [30, 80],
    maxEpisodeRefs: 12,
  },
  workstreamSummary: {
    targetWords: [120, 240],
    maxCurrentDecisions: 8,
    maxNextSteps: 8,
    maxBlockers: 6,
  },
  distilled: {
    targetWords: [60, 160],
    maxSourceRefs: 12,
  },
} as const;

export const QUALITY_THRESHOLDS = {
  minFactConfidence: 0.55,
  minFactQualityScore: 0.6,
  minImportanceForLowConfidenceFact: 0.75,
  rejectStatusOnlyFacts: true,
  rejectDuplicatedTranscriptNarration: true,
} as const;

export const CAPTURE_KIND_SUBTYPES = {
  fact: [
    "codebase_map",
    "architecture_decision",
    "infra_topology",
    "access_pattern",
    "operational_procedure",
    "domain_rule",
    "product_decision",
    "product_requirement",
    "user_workflow",
    "roadmap_item",
    "success_metric",
    "market_insight",
    "troubleshooting_gotcha",
    "preference",
    "person_profile",
    "ownership_note",
    "working_agreement",
    "activity_event",
  ],
  summary: ["session_index", "episode", "workstream"],
  distilled: ["convention"],
} as const satisfies Partial<Record<Kind, readonly MemorySubtype[]>>;

export const FACT_CATEGORY_TO_SUBTYPE: Record<Category, MemorySubtype> = {
  engineering: "codebase_map",
  product: "domain_rule",
  human: "preference",
  system: "codebase_map",
};

export const DEFAULT_CAPTURE_CONTEXT = {
  domain: DEFAULT_DOMAIN,
  source: "system",
  reviewStatus: "candidate",
  // Default fallback volatility when the LLM does not self-judge. Storage path
  // overrides this with the LLM's value (or the volatility verifier's
  // synthesised value) — see daemon/extraction.ts storeFacts.
  volatility: "evolving",
} as const;

export function promptVersionForSubtype(subtype: MemorySubtype): string {
  if (subtype === "session_index") return PROMPT_VERSIONS.sessionIndex;
  if (subtype === "episode") return PROMPT_VERSIONS.episodeSummary;
  if (subtype === "workstream") return PROMPT_VERSIONS.workstreamSummary;
  if (subtype === "convention") {
    return PROMPT_VERSIONS.distillation;
  }
  return PROMPT_VERSIONS.factExtraction;
}

export function subtypeForCategory(category: Category): MemorySubtype {
  return FACT_CATEGORY_TO_SUBTYPE[category];
}
