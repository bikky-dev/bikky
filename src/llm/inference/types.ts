/**
 * Types for the pluggable inference (chat-completion) registry.
 *
 * Each provider declares a name, defaults, and a `chat()` method. The registry
 * dispatches by `cfg.provider` (a string), so adding a new provider is a single
 * file under ./providers/ + one line in ./providers/index.ts.
 */

export interface ResolvedInferenceConfig {
  /** Provider name as registered (e.g. "ollama"). */
  provider: string;
  /** Model identifier passed to the provider. */
  model: string;
  /** Base URL for HTTP providers; "" for SDK-only providers. */
  baseUrl: string;
  /** Auth token / API key, or null when none required. */
  apiKey: string | null;
  /** Optional fallback provider name — used when `chat()` returns null. */
  fallback: string | null;
  /** Provider-specific extras (e.g. bedrock region, portkey virtual-key). */
  extra: Record<string, string | undefined>;
  /** Per-request timeout in milliseconds (HTTP providers). Defaults set by initLLM. */
  timeoutMs: number;
  /** Max retries on transient/rate-limit/timeout failures. */
  retries: number;
  /** Base backoff delay in milliseconds (full-jitter exponential). */
  retryBaseDelayMs: number;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchemaSpec };

export interface JsonSchemaSpec {
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}

export interface ChatCompletionOpts {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: ResponseFormat;
  /** id@version prompt stamp from the prompt registry, used for telemetry. */
  promptName?: string;
  telemetry?: ChatCompletionTelemetryContext;
}

export interface ChatCompletionTelemetryContext {
  subsystem?: string;
  session_id?: string;
  workstream_key?: string;
  trigger?: string;
}

export interface ChatCompletionUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  request_id?: string;
}

export interface InferenceProvider {
  /** Stable identifier used in config (lowercase). */
  readonly name: string;
  /** Human label for logs. */
  readonly label: string;
  /** Defaults applied when caller omits model/baseUrl. */
  readonly defaults: {
    model: string;
    baseUrl?: string;
  };
  /** Whether this provider can be called from a browser. */
  readonly browserCompatible: boolean;
  /**
   * Run one chat completion. Return the assistant's text on success; return
   * `null` on a recoverable failure (HTTP error, missing key, network) so the
   * orchestrator can fall back. Throw only for programmer errors.
   */
  chat(opts: ChatCompletionOpts, cfg: ResolvedInferenceConfig, log: LogFn): Promise<string | null>;
}

export type LogFn = (level: string, ...args: unknown[]) => void;

export interface InitLLMInput {
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string | null;
  /** Provider name to fall back to when primary returns null. */
  fallback?: string | null;
  extra?: Record<string, string | undefined>;
  /** Per-request HTTP timeout. Defaults to 30s. */
  timeoutMs?: number;
  /** Max retries on transient/rate-limit/timeout failures. Defaults to 2. */
  retries?: number;
  /** Base backoff delay (ms) for retries. Defaults to 250ms. */
  retryBaseDelayMs?: number;
}
