/**
 * Prompt registry — every LLM prompt in bikky lives here.
 *
 * Each prompt declares:
 *   - id: stable identifier used in telemetry and fact metadata
 *   - version: date-stamped string; bump when the prompt changes
 *   - build(input): renders {system, user, response_format, temperature, max_tokens}
 *
 * Prompts share a common skeleton:
 *   <role>     1-line persona
 *   <task>     what to do
 *   <rules>    quality gate / what to skip
 *   <examples> 2 good + 1 bad
 *   <format>   exact output schema
 *   <data>     supplied as user message wrapped in tags
 *
 * Anti-injection: any user-supplied text appears wrapped in semantic tags inside
 * the user message; the system message tells the model that tagged content is
 * data, not instructions.
 */

import type { ChatCompletionOpts, ResponseFormat } from "../llm/index.js";

// ── Common types ────────────────────────────────────────────────────────────

export interface PromptDescriptor {
  id: string;
  version: string;
}

export interface RenderedPrompt extends ChatCompletionOpts {
  /** id@version — stamped onto telemetry and fact metadata */
  promptName: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Wrap arbitrary user-supplied text so the model treats it as data, not
 * instructions. The opening line tells the model what the wrapper means.
 */
export function wrapData(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}

/** Build a chat-completion options object stamped with promptName. */
export function buildOpts(
  desc: PromptDescriptor,
  parts: {
    system: string;
    user: string;
    temperature?: number;
    max_tokens?: number;
    response_format?: ResponseFormat;
  },
): RenderedPrompt {
  return {
    promptName: `${desc.id}@${desc.version}`,
    messages: [
      { role: "system", content: parts.system },
      { role: "user", content: parts.user },
    ],
    temperature: parts.temperature ?? 0.2,
    max_tokens: parts.max_tokens ?? 1500,
    response_format: parts.response_format,
  };
}

/** Strip ```json fences and parse, returning null on failure. */
export function safeParseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  // Try as-is first
  try {
    return JSON.parse(cleaned) as T;
  } catch { /* fall through */ }
  // Brace-balance: find first { or [, walk to matching close, ignoring braces inside strings
  const firstIdx = cleaned.search(/[{[]/);
  if (firstIdx < 0) return null;
  const open = cleaned[firstIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = firstIdx; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(firstIdx, i + 1)) as T; }
        catch { return null; }
      }
    }
  }
  return null;
}

// ── Re-exports of individual prompt builders ────────────────────────────────

export { extractionPrompt, EXTRACTION_PROMPT_DESCRIPTOR } from "./extraction.js";
export { distillPrompt, DISTILL_PROMPT_DESCRIPTOR } from "./distill.js";
export { contradictionPrompt, CONTRADICTION_PROMPT_DESCRIPTOR } from "./contradiction.js";
export { relationsPrompt, RELATIONS_PROMPT_DESCRIPTOR } from "./relations.js";
export { briefPrompt, BRIEF_PROMPT_DESCRIPTOR, ALLOWED_BRIEF_HEADINGS } from "./brief.js";
