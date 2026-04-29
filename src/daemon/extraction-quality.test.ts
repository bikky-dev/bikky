// Golden-set eval for the extraction grounding pipeline (Phase 3 of #46).
//
// Each case below is a complete extracted-fact candidate (as the LLM would emit
// it) plus the verdict we expect from the structural verifier stack. A "bad"
// case must end up dropped or marked ambiguous; a "good" case must pass through
// untouched. The suite asserts ≥90% precision and ≥90% recall on this set.
//
// Add new cases at the bottom — never delete existing ones, so we have a
// regression history. The five cases marked as cited are the bad facts called
// out in the task description.

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyGrounding, verifyVolatilityCoherence } from "./extraction-rules.js";

interface GoldenCase {
  id: string;
  label: "good" | "bad";
  source: string;
  fact: {
    content: string;
    subject?: string;
    subject_specificity?: number;
    self_contained?: boolean;
    entities: string[];
    volatility?: "stable" | "evolving" | "transient" | "ephemeral";
    as_of?: string;
    category?: string;
  };
  expectedVerdict?: "grounded" | "ambiguous" | "ungrounded";
  expectedForcedCategory?: string | null;
  expectedExpiry?: "set" | "null";
}

const GOLDEN: GoldenCase[] = [
  // ----- BAD facts cited in the task -----
  {
    id: "cited-pipeline",
    label: "bad",
    source: "task #46",
    fact: {
      content: "The pipeline uses pre-built Docker images pulled from ECR for deployment.",
      subject: "the pipeline",
      subject_specificity: 0.2,
      self_contained: false,
      entities: ["docker", "ecr"],
    },
    expectedVerdict: "ungrounded",
  },
  {
    id: "cited-image-tag",
    label: "bad",
    source: "task #46 (transient)",
    fact: {
      content: "The correct image tag for the SCB init container should be `097873b`.",
      subject: "scb init container image tag",
      subject_specificity: 0.7,
      self_contained: true,
      entities: ["scb", "init-container"],
      volatility: "transient",
      as_of: "2026-04-28",
    },
    expectedVerdict: "grounded",
    expectedForcedCategory: "engineering",
    expectedExpiry: "set",
  },
  {
    id: "cited-step-2",
    label: "bad",
    source: "task #46",
    fact: {
      content: "Step 2 is a part of the dbt cronjob.",
      subject: "step 2",
      subject_specificity: 0.15,
      self_contained: false,
      entities: ["dbt"],
    },
    expectedVerdict: "ungrounded",
  },
  {
    id: "cited-deployment-process",
    label: "bad",
    source: "task #46",
    fact: {
      content: "The deployment process involves building locally, pushing to ECR, and restarting on EC2 via SSM.",
      subject: "the deployment process",
      subject_specificity: 0.25,
      self_contained: false,
      entities: ["ecr", "ec2", "ssm"],
    },
    expectedVerdict: "ungrounded",
  },
  {
    id: "cited-cronjob-old-image",
    label: "bad",
    source: "task #46 (transient)",
    fact: {
      content: "The scheduled cronjob `dbt-run-cronjob-v100-29617080` is still running the old image.",
      subject: "dbt-run-cronjob-v100-29617080",
      subject_specificity: 0.9,
      self_contained: true,
      entities: ["dbt-run-cronjob-v100-29617080"],
      volatility: "transient",
      as_of: "2026-04-28",
    },
    expectedVerdict: "grounded",
    expectedForcedCategory: "engineering",
    expectedExpiry: "set",
  },

  // ----- GOOD facts -----
  {
    id: "good-makefile-target",
    label: "good",
    source: "synthetic",
    fact: {
      content: "Running `make deploy-prod` in the bikky-infra repo applies the EKS Helm chart.",
      subject: "make deploy-prod",
      subject_specificity: 0.95,
      self_contained: true,
      entities: ["bikky-infra", "eks", "helm"],
      volatility: "stable",
    },
    expectedVerdict: "grounded",
    expectedForcedCategory: null,
    expectedExpiry: "null",
  },
  {
    id: "good-config-path",
    label: "good",
    source: "synthetic",
    fact: {
      content: "The Bikky daemon reads its config from `~/.bikky/config.json`.",
      subject: "~/.bikky/config.json",
      subject_specificity: 1.0,
      self_contained: true,
      entities: ["bikky", "config.json"],
      volatility: "stable",
    },
    expectedVerdict: "grounded",
  },
  {
    id: "good-version-bump",
    label: "good",
    source: "synthetic",
    fact: {
      content: "Bikky package version was bumped to 0.3.5 on the main branch.",
      subject: "bikky package version",
      subject_specificity: 0.85,
      self_contained: true,
      entities: ["bikky"],
      volatility: "evolving",
    },
    expectedVerdict: "grounded",
  },
  {
    id: "good-architecture-decision",
    label: "good",
    source: "synthetic",
    fact: {
      content: "Bikky stores embeddings in a Qdrant collection named `bikky`.",
      subject: "bikky qdrant collection",
      subject_specificity: 0.9,
      self_contained: true,
      entities: ["qdrant", "bikky"],
      volatility: "stable",
    },
    expectedVerdict: "grounded",
  },
  {
    id: "good-ownership",
    label: "good",
    source: "synthetic",
    fact: {
      content: "The bikky-ui repo owns the EntityChip component at `packages/ui/app/src/components/EntityChip.tsx`.",
      subject: "EntityChip.tsx",
      subject_specificity: 0.95,
      self_contained: true,
      entities: ["bikky-ui", "entitychip"],
      volatility: "stable",
    },
    expectedVerdict: "grounded",
  },
  {
    id: "good-ephemeral-status",
    label: "good",
    source: "synthetic (ephemeral)",
    fact: {
      content: "The daemon at PID 39445 is currently consuming 240MB RSS.",
      subject: "daemon pid 39445",
      subject_specificity: 0.9,
      self_contained: true,
      entities: ["bikky-daemon"],
      volatility: "ephemeral",
      as_of: "2026-04-28",
    },
    expectedVerdict: "grounded",
    expectedForcedCategory: "engineering",
    expectedExpiry: "set",
  },
  {
    id: "good-typed-token-rescues",
    label: "good",
    source: "synthetic",
    fact: {
      content: "The `extraction-rules.ts` module exports `verifyGrounding`.",
      subject: "extraction-rules.ts",
      subject_specificity: 0.9,
      self_contained: true,
      entities: ["extraction-rules.ts"],
    },
    expectedVerdict: "grounded",
  },
  {
    id: "bad-vague-process",
    label: "bad",
    source: "synthetic",
    fact: {
      content: "The process is faster now.",
      subject: "the process",
      subject_specificity: 0.1,
      self_contained: false,
      entities: [],
    },
    expectedVerdict: "ungrounded",
  },
  {
    id: "bad-no-anchor",
    label: "bad",
    source: "synthetic",
    fact: {
      content: "Things have been improved significantly.",
      subject: "things",
      subject_specificity: 0.05,
      self_contained: false,
      entities: [],
    },
    expectedVerdict: "ungrounded",
  },
];

function evaluate(c: GoldenCase): {
  verdict: "grounded" | "ambiguous" | "ungrounded";
  forcedCategory: string | null;
  expiresAt: string | null;
} {
  const grounding = verifyGrounding({
    content: c.fact.content,
    subject: c.fact.subject,
    subject_specificity: c.fact.subject_specificity,
    self_contained: c.fact.self_contained,
    entities: c.fact.entities,
  });
  const volatility = verifyVolatilityCoherence({
    volatility: c.fact.volatility,
    as_of: c.fact.as_of,
    category: c.fact.category,
  });
  return {
    verdict: grounding.verdict,
    forcedCategory: volatility.forcedCategory,
    expiresAt: volatility.expiresAt,
  };
}

test("golden set: every case meets its expected verdict", () => {
  const failures: string[] = [];
  for (const c of GOLDEN) {
    const r = evaluate(c);
    if (c.expectedVerdict && r.verdict !== c.expectedVerdict) {
      failures.push(`${c.id}: expected verdict=${c.expectedVerdict} got ${r.verdict}`);
    }
    if (c.expectedForcedCategory !== undefined && r.forcedCategory !== c.expectedForcedCategory) {
      failures.push(
        `${c.id}: expected forcedCategory=${c.expectedForcedCategory} got ${r.forcedCategory}`,
      );
    }
    if (c.expectedExpiry === "set" && !r.expiresAt) {
      failures.push(`${c.id}: expected expiresAt to be set`);
    }
    if (c.expectedExpiry === "null" && r.expiresAt) {
      failures.push(`${c.id}: expected expiresAt to be null, got ${r.expiresAt}`);
    }
  }
  assert.equal(failures.length, 0, `Golden-set failures:\n${failures.join("\n")}`);
});

test("golden set: precision ≥ 0.9 (good facts not dropped or downgraded)", () => {
  const goods = GOLDEN.filter((c) => c.label === "good");
  let kept = 0;
  for (const c of goods) {
    const { verdict } = evaluate(c);
    if (verdict === "grounded") kept++;
  }
  const precision = kept / goods.length;
  assert.ok(
    precision >= 0.9,
    `Precision ${precision.toFixed(2)} below 0.9 (${kept}/${goods.length} good facts kept)`,
  );
});

test("golden set: recall ≥ 0.9 (bad facts caught — dropped or downgraded or expiring)", () => {
  const bads = GOLDEN.filter((c) => c.label === "bad");
  let caught = 0;
  for (const c of bads) {
    const r = evaluate(c);
    const isCaught =
      r.verdict === "ungrounded" ||
      r.verdict === "ambiguous" ||
      r.forcedCategory !== null ||
      r.expiresAt !== null;
    if (isCaught) caught++;
  }
  const recall = caught / bads.length;
  assert.ok(
    recall >= 0.9,
    `Recall ${recall.toFixed(2)} below 0.9 (${caught}/${bads.length} bad facts caught)`,
  );
});
