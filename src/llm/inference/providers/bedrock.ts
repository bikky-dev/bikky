/**
 * AWS Bedrock chat-completion provider — Converse API.
 *
 * The AWS SDK is dynamic-imported on first call so that users on Ollama or
 * OpenAI never pay the bundle cost.
 *
 * Region resolution order: cfg.extra.region → AWS_BEDROCK_REGION → AWS_REGION → "us-east-1".
 * Credentials follow the SDK default chain (env → shared file → SSO → IAM role).
 *
 * Errors: SDK exceptions are translated to typed `LlmHttpError` subclasses
 * (using `$metadata.httpStatusCode`) and recorded via `_recordInferenceError`,
 * matching the contract used by the HTTP-based providers.
 */

import type {
  InferenceProvider,
  ChatCompletionOpts,
  ResolvedInferenceConfig,
  LogFn,
  ChatMessage,
} from "../types.js";
import { registerInferenceProvider } from "../registry.js";
import {
  classifyHttpStatus,
  LlmAuthError,
  LlmBadRequestError,
  LlmRateLimitError,
  LlmTransientError,
  LlmUnknownError,
  type LlmErrorDetails,
  type LlmHttpError,
} from "../../errors.js";
import { _recordInferenceError } from "../index.js";

interface BedrockSdk {
  client: { send(cmd: unknown): Promise<{ output?: { message?: { content?: Array<{ text?: string }> } } }> };
  // Use any here — the AWS ConverseCommand input type is a deeply-nested SDK
  // type; we only ever pass it shape-checked objects from this file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ConverseCommand: new (input: any) => unknown;
}

let sdk: BedrockSdk | null = null;

async function ensureSdk(cfg: ResolvedInferenceConfig): Promise<BedrockSdk> {
  if (sdk) return sdk;
  const mod = await import("@aws-sdk/client-bedrock-runtime");
  const region = cfg.extra.region
    ?? process.env.AWS_BEDROCK_REGION
    ?? process.env.AWS_REGION
    ?? "us-east-1";
  const next: BedrockSdk = {
    client: new mod.BedrockRuntimeClient({ region }),
    ConverseCommand: mod.ConverseCommand,
  };
  sdk = next;
  return next;
}

function translateSdkError(err: unknown, model: string): LlmHttpError {
  const e = err as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = e.$metadata?.httpStatusCode;
  const details: LlmErrorDetails = {
    provider: "bedrock",
    model,
    status,
    body: e.message ?? e.name,
    cause: err,
  };
  if (status === undefined) {
    return new LlmTransientError(details);
  }
  switch (classifyHttpStatus(status)) {
    case "auth": return new LlmAuthError(details);
    case "rate_limit": return new LlmRateLimitError(details);
    case "bad_request": return new LlmBadRequestError(details);
    case "transient": return new LlmTransientError(details);
    default: return new LlmUnknownError(details);
  }
}

/** Test-only: drop the cached SDK so tests can swap or reset it. */
export function _resetBedrockInferenceClient(): void {
  sdk = null;
}

export const bedrockInferenceProvider: InferenceProvider = {
  name: "bedrock",
  label: "AWS Bedrock (Converse)",
  browserCompatible: false,
  defaults: {
    model: "us.anthropic.claude-sonnet-4-20250514",
  },
  async chat(opts: ChatCompletionOpts, cfg: ResolvedInferenceConfig, log: LogFn): Promise<string | null> {
    const { client, ConverseCommand } = await ensureSdk(cfg);

    const systemBlocks: Array<{ text: string }> = [];
    const messages: Array<{ role: "user" | "assistant"; content: Array<{ text: string }> }> = [];

    for (const m of opts.messages as ChatMessage[]) {
      if (m.role === "system") {
        systemBlocks.push({ text: m.content });
      } else {
        messages.push({
          role: m.role as "user" | "assistant",
          content: [{ text: m.content }],
        });
      }
    }

    try {
      const command = new ConverseCommand({
        modelId: cfg.model,
        messages,
        ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
        inferenceConfig: {
          maxTokens: opts.max_tokens ?? 500,
          temperature: opts.temperature ?? 0.2,
        },
      });
      const resp = await client.send(command);
      _recordInferenceError(null);
      const content = resp.output?.message?.content;
      const textBlock = content?.find((c) => "text" in c);
      return (textBlock?.text ?? "").trim() || null;
    } catch (e: unknown) {
      const err = translateSdkError(e, cfg.model);
      _recordInferenceError(err);
      log("WARN", `LLM Bedrock ${err.kind}${err.status !== undefined ? ` (${err.status})` : ""}: ${err.message}`);
      return null;
    }
  },
};

registerInferenceProvider(bedrockInferenceProvider);
