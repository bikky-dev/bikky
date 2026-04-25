/**
 * `bikky render` — render a prompt to JSON without booting the MCP server.
 *
 * Designed for external evaluation harnesses (e.g. DeepEval-based test suites)
 * and for debugging prompts manually. Prompts remain the single source of truth
 * in src/prompts/; consumers shell out to this command instead of re-implementing
 * the rendering logic.
 *
 * Usage:
 *   bikky render <name>                  # reads input JSON from stdin
 *   bikky render <name> --input <path>   # reads input JSON from file
 *   bikky render --list                  # list available prompts
 *
 * Output (stdout): JSON object with promptName, messages, temperature, etc.
 * Errors → stderr, exit 1.
 */

import fs from "node:fs";
import {
  extractionPrompt,
  distillPrompt,
  contradictionPrompt,
  relationsPrompt,
  briefPrompt,
  EXTRACTION_PROMPT_DESCRIPTOR,
  DISTILL_PROMPT_DESCRIPTOR,
  CONTRADICTION_PROMPT_DESCRIPTOR,
  RELATIONS_PROMPT_DESCRIPTOR,
  BRIEF_PROMPT_DESCRIPTOR,
  type RenderedPrompt,
} from "./prompts/index.js";

interface PromptEntry {
  id: string;
  version: string;
  describe: string;
  build: (input: unknown) => RenderedPrompt;
}

export const PROMPT_REGISTRY: Record<string, PromptEntry> = {
  extraction: {
    id: EXTRACTION_PROMPT_DESCRIPTOR.id,
    version: EXTRACTION_PROMPT_DESCRIPTOR.version,
    describe: 'Extract atomic facts from a session transcript. Input: { transcript: string, systemOverride?: string|null }',
    build: (input) => extractionPrompt(input as Parameters<typeof extractionPrompt>[0]),
  },
  distill: {
    id: DISTILL_PROMPT_DESCRIPTOR.id,
    version: DISTILL_PROMPT_DESCRIPTOR.version,
    describe: 'Consolidate >=3 session summaries into reusable patterns. Input: { summaries: [{ id, date, content, tasks_completed?, decisions_made? }] }',
    build: (input) => distillPrompt(input as Parameters<typeof distillPrompt>[0]),
  },
  contradiction: {
    id: CONTRADICTION_PROMPT_DESCRIPTOR.id,
    version: CONTRADICTION_PROMPT_DESCRIPTOR.version,
    describe: 'Decide whether a new fact contradicts existing candidates. Input: { newFact: { content, category }, candidates: [{ id, content, category, score }] }',
    build: (input) => contradictionPrompt(input as Parameters<typeof contradictionPrompt>[0]),
  },
  relations: {
    id: RELATIONS_PROMPT_DESCRIPTOR.id,
    version: RELATIONS_PROMPT_DESCRIPTOR.version,
    describe: 'Infer typed relations between two entities from shared facts. Input: { entityA, entityB, sharedFacts: [{ content, category }] }',
    build: (input) => relationsPrompt(input as Parameters<typeof relationsPrompt>[0]),
  },
  brief: {
    id: BRIEF_PROMPT_DESCRIPTOR.id,
    version: BRIEF_PROMPT_DESCRIPTOR.version,
    describe: 'Generate a session briefing from grouped fact sections. Input: { generatedAt: ISO date, sections: { <heading>: string[] } }',
    build: (input) => briefPrompt(input as Parameters<typeof briefPrompt>[0]),
  },
};

export function listPrompts(): Array<{ name: string; id: string; version: string; describe: string }> {
  return Object.entries(PROMPT_REGISTRY).map(([name, entry]) => ({
    name,
    id: entry.id,
    version: entry.version,
    describe: entry.describe,
  }));
}

export function renderPrompt(name: string, input: unknown): RenderedPrompt {
  const entry = PROMPT_REGISTRY[name];
  if (!entry) {
    const available = Object.keys(PROMPT_REGISTRY).join(", ");
    throw new Error(`Unknown prompt: "${name}". Available: ${available}`);
  }
  return entry.build(input);
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read stdin: ${(err as Error).message}`);
  }
}

interface ParsedArgs {
  name: string | null;
  inputPath: string | null;
  list: boolean;
  help: boolean;
}

export function parseRenderArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { name: null, inputPath: null, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list" || a === "-l") {
      args.list = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--input" || a === "-i") {
      args.inputPath = argv[++i] ?? null;
      if (!args.inputPath) {
        throw new Error("--input requires a path argument");
      }
    } else if (a.startsWith("--input=")) {
      args.inputPath = a.slice("--input=".length);
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    } else if (args.name === null) {
      args.name = a;
    } else {
      throw new Error(`Unexpected positional argument: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage:
  bikky render <name>                  Render prompt; reads JSON input from stdin
  bikky render <name> --input <path>   Render prompt; reads JSON input from file
  bikky render --list                  List available prompts
  bikky render --help                  Show this help

Available prompts:`);
  for (const p of listPrompts()) {
    console.log(`  ${p.name.padEnd(15)} ${p.id}@${p.version}`);
    console.log(`  ${"".padEnd(15)} ${p.describe}`);
  }
}

export async function runRenderCli(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseRenderArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error("Run `bikky render --help` for usage.");
    return 1;
  }

  if (parsed.help) {
    printHelp();
    return 0;
  }

  if (parsed.list) {
    console.log(JSON.stringify(listPrompts(), null, 2));
    return 0;
  }

  if (!parsed.name) {
    console.error("Error: prompt name is required");
    console.error("Run `bikky render --help` for usage.");
    return 1;
  }

  let raw: string;
  try {
    raw = parsed.inputPath ? fs.readFileSync(parsed.inputPath, "utf-8") : readStdinSync();
  } catch (err) {
    console.error(`Error reading input: ${(err as Error).message}`);
    return 1;
  }

  if (!raw.trim()) {
    console.error("Error: input JSON is empty (provide via stdin or --input)");
    return 1;
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    console.error(`Error parsing input JSON: ${(err as Error).message}`);
    return 1;
  }

  let rendered: RenderedPrompt;
  try {
    rendered = renderPrompt(parsed.name, input);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  console.log(JSON.stringify(rendered, null, 2));
  return 0;
}
