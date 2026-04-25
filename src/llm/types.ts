/**
 * Cross-cutting types not specific to embedding or inference.
 * Embedding types live in ./embedding/types.ts.
 * Inference types (ChatCompletionOpts, ResponseFormat, JsonSchemaSpec, etc.)
 * live in ./inference/types.ts.
 */

export type LogFn = (level: string, ...args: unknown[]) => void;

