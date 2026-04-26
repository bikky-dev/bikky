/**
 * AWS Bedrock embedding provider — Titan Embed V2 via the Bedrock Runtime SDK.
 *
 * The @aws-sdk/client-bedrock-runtime package is heavy (~5 MB), so we
 * dynamic-import it inside init() — users on Ollama/OpenAI/Portkey never pay
 * the cold-start cost.
 *
 * Errors: SDK exceptions are translated into the shared `LlmHttpError`
 * hierarchy when possible (using `$metadata.httpStatusCode`) so callers can
 * branch on `err.kind` the same way they do for HTTP-based providers.
 */

import { registerEmbeddingProvider } from "../registry.js";
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
import type { EmbeddingProvider, ResolvedEmbeddingConfig } from "../types.js";

interface TitanEmbedResponse {
  embedding: number[];
}

// Loaded dynamically on first init/embed.
type BedrockClient = {
  send: (cmd: unknown) => Promise<{ body: Uint8Array }>;
};
type InvokeModelCommandCtor = new (input: {
  modelId: string;
  contentType: string;
  accept: string;
  body: Uint8Array;
}) => unknown;

let client: BedrockClient | null = null;
let InvokeModelCommand: InvokeModelCommandCtor | null = null;

async function ensureSdk(cfg: ResolvedEmbeddingConfig): Promise<void> {
  if (client && InvokeModelCommand) return;
  const region =
    cfg.extra.region ??
    process.env.AWS_BEDROCK_REGION ??
    process.env.AWS_REGION ??
    "us-east-1";
  const sdk = await import("@aws-sdk/client-bedrock-runtime");
  // SDK resolves credentials via its default chain (env → shared credentials → SSO → IAM role).
  client = new sdk.BedrockRuntimeClient({ region }) as unknown as BedrockClient;
  InvokeModelCommand = sdk.InvokeModelCommand as unknown as InvokeModelCommandCtor;
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

export const bedrockEmbeddingProvider: EmbeddingProvider = {
  name: "bedrock",
  label: "AWS Bedrock (Titan Embed)",
  browserCompatible: false,
  defaults: {
    model: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
  },
  async embed(text: string, cfg: ResolvedEmbeddingConfig): Promise<number[]> {
    await ensureSdk(cfg);
    const payload = JSON.stringify({
      inputText: text,
      dimensions: cfg.dimensions,
      normalize: true,
    });
    const command = new InvokeModelCommand!({
      modelId: cfg.model,
      contentType: "application/json",
      accept: "application/json",
      body: new TextEncoder().encode(payload),
    });
    let resp: { body: Uint8Array };
    try {
      resp = await client!.send(command);
    } catch (e) {
      throw translateSdkError(e, cfg.model);
    }
    const raw = JSON.parse(new TextDecoder().decode(resp.body)) as TitanEmbedResponse;
    if (!raw.embedding) {
      throw new Error(`Embedding response from bedrock missing data (model: ${cfg.model})`);
    }
    return raw.embedding;
  },
};

registerEmbeddingProvider(bedrockEmbeddingProvider);

/** Test-only: drop the cached SDK so unit tests can re-mock the dynamic import. */
export function _resetBedrockEmbeddingClient(): void {
  client = null;
  InvokeModelCommand = null;
}
