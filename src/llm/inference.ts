/**
 * Unified LLM chat-completion client.
 * Routes to Ollama (default), OpenAI, or Bedrock based on config.
 * Ollama → Bedrock fallback when Ollama is primary and fails.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message as BedrockMessage,
  type SystemContentBlock,
} from "@aws-sdk/client-bedrock-runtime";

import type { InferenceProviderConfig, ChatCompletionOpts, LogFn } from "./types.js";

// ── Module state ─────────────────────────────────────────────────────────────

let cfg: InferenceProviderConfig | null = null;
let log: LogFn = () => {};
let bedrockClient: BedrockRuntimeClient | null = null;

export function initLLM(opts: { config: InferenceProviderConfig; logger?: LogFn }): void {
  cfg = opts.config;
  if (opts.logger) log = opts.logger;

  if (cfg.provider === "bedrock") initBedrockClient();
}

function initBedrockClient(): void {
  const region = cfg?.bedrock_region ?? process.env.AWS_BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  const credentials = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
    : undefined;
  bedrockClient = new BedrockRuntimeClient({ region, credentials });
}

// ── Core function ────────────────────────────────────────────────────────────

export async function chatCompletion(opts: ChatCompletionOpts): Promise<string | null> {
  const provider = cfg?.provider ?? "ollama";

  if (provider === "openai") return openaiCompletion(opts);

  if (provider === "ollama") {
    const result = await ollamaCompletion(opts);
    if (result !== null) return result;
    log("INFO", "LLM: Ollama failed, falling back to Bedrock");
    return bedrockCompletion(opts);
  }

  return bedrockCompletion(opts);
}

// ── Provider implementations ─────────────────────────────────────────────────

async function ollamaCompletion(opts: ChatCompletionOpts): Promise<string | null> {
  const baseUrl = cfg?.ollama_url ?? "http://localhost:11434";
  const model = cfg?.ollama_model ?? "qwen2.5:7b";

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.max_tokens ?? 500,
  };
  if (opts.response_format) {
    body.response_format = opts.response_format.type === "json_schema"
      ? { type: "json_object" }
      : opts.response_format;
  }

  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      log("WARN", `LLM Ollama error (${resp.status}): ${err.slice(0, 200)}`);
      return null;
    }
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e: unknown) {
    log("WARN", `LLM Ollama unreachable: ${(e as Error).message}`);
    return null;
  }
}

async function openaiCompletion(opts: ChatCompletionOpts): Promise<string | null> {
  const apiKey = cfg?.openai_api_key;
  if (!apiKey) { log("WARN", "LLM OpenAI: no API key"); return null; }

  const model = cfg?.openai_model ?? "gpt-4.1-mini";
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.max_tokens ?? 500,
  };
  if (opts.response_format) body.response_format = opts.response_format;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      log("WARN", `LLM OpenAI error (${resp.status}): ${err.slice(0, 200)}`);
      return null;
    }
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e: unknown) {
    log("WARN", `LLM OpenAI error: ${(e as Error).message}`);
    return null;
  }
}

async function bedrockCompletion(opts: ChatCompletionOpts): Promise<string | null> {
  if (!bedrockClient) initBedrockClient();

  const modelId = cfg?.bedrock_model ?? "us.anthropic.claude-sonnet-4-20250514";

  const systemBlocks: SystemContentBlock[] = [];
  const messages: BedrockMessage[] = [];

  for (const m of opts.messages) {
    if (m.role === "system") {
      systemBlocks.push({ text: m.content });
    } else {
      messages.push({
        role: m.role as "user" | "assistant",
        content: [{ text: m.content }] as ContentBlock[],
      });
    }
  }

  try {
    const command = new ConverseCommand({
      modelId,
      messages,
      ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
      inferenceConfig: {
        maxTokens: opts.max_tokens ?? 500,
        temperature: opts.temperature ?? 0.2,
      },
    });

    const resp = await bedrockClient!.send(command);
    const content = resp.output?.message?.content;
    const textBlock = content?.find(c => "text" in c);
    return (textBlock as { text: string })?.text?.trim() ?? null;
  } catch (e: unknown) {
    log("WARN", `LLM Bedrock error: ${(e as Error).message}`);
    return null;
  }
}
