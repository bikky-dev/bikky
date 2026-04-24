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
import { estimateTokens, writeTelemetry } from "./telemetry.js";

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
  // Let the AWS SDK resolve credentials via its default chain:
  // env vars → shared credentials file → SSO → IAM role
  bedrockClient = new BedrockRuntimeClient({ region });
}

// ── Core function ────────────────────────────────────────────────────────────

export async function chatCompletion(opts: ChatCompletionOpts): Promise<string | null> {
  const provider = cfg?.provider ?? "ollama";
  const promptName = opts.promptName ?? "unknown";
  const tokensIn = estimateTokens(opts.messages.map((m) => m.content).join("\n"));

  const run = async (
    impl: (o: ChatCompletionOpts) => Promise<string | null>,
    actualProvider: "ollama" | "openai" | "bedrock",
    model: string,
  ): Promise<string | null> => {
    const t0 = Date.now();
    let result: string | null = null;
    let err: string | undefined;
    try {
      result = await impl(opts);
    } catch (e: unknown) {
      err = (e as Error).message;
    }
    void writeTelemetry(
      {
        ts: new Date().toISOString(),
        prompt: promptName,
        model,
        provider: actualProvider,
        ok: result !== null,
        latency_ms: Date.now() - t0,
        tokens_in_est: tokensIn,
        tokens_out_est: result ? estimateTokens(result) : 0,
        error: err,
        request_id: opts.requestId,
      },
      log,
    );
    return result;
  };

  if (provider === "openai") {
    return run(openaiCompletion, "openai", cfg?.openai_model ?? "gpt-4.1-mini");
  }

  if (provider === "ollama") {
    const result = await run(ollamaCompletion, "ollama", cfg?.ollama_model ?? "qwen2.5:7b");
    if (result !== null) return result;
    log("INFO", "LLM: Ollama failed, falling back to Bedrock");
    return run(bedrockCompletion, "bedrock", cfg?.bedrock_model ?? "us.anthropic.claude-sonnet-4-20250514");
  }

  return run(bedrockCompletion, "bedrock", cfg?.bedrock_model ?? "us.anthropic.claude-sonnet-4-20250514");
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

  // Bedrock Converse silently ignores response_format. When the caller asked for
  // JSON, prepend a hard JSON-only directive to the system blocks so the model
  // produces parseable output.
  if (opts.response_format && opts.response_format.type === "json_object") {
    systemBlocks.push({
      text: "Output VALID JSON ONLY. No markdown code fences. No prose before or after the JSON. The first character of your reply MUST be { or [.",
    });
  }

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
}
