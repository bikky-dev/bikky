/**
 * Shared types for embedding and inference providers.
 */

export type LogFn = (level: string, ...args: unknown[]) => void;

// ── Embedding ───────────────────────────────────────────────────────────────

export interface EmbeddingProviderConfig {
  provider: "ollama" | "openai" | "bedrock";
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKey: string | null;
}

// ── Inference ───────────────────────────────────────────────────────────────

export interface InferenceProviderConfig {
  provider: "ollama" | "openai" | "bedrock";
  ollama_url: string;
  ollama_model: string;
  openai_api_key: string | null;
  openai_model: string;
  bedrock_region: string;
  bedrock_model: string;
}

export interface ChatCompletionOpts {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  response_format?: ResponseFormat;
  /** Stable "id@version" — used for telemetry and downstream metadata. Optional. */
  promptName?: string;
  /** Caller-supplied request id for correlating telemetry across systems. Optional. */
  requestId?: string;
}

export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchemaSpec };

export interface JsonSchemaSpec {
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}
