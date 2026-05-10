import type { RoutingInput } from "./routing.js";

type RoutingMetadata = Record<string, unknown>;

export interface MemoryRoutingInput {
  destination?: string | null;
  cwd?: string;
  content?: string | null;
  entities?: ReadonlyArray<string>;
  metadata?: RoutingMetadata | null;
  context?: RoutingMetadata | null;
  extraContent?: ReadonlyArray<unknown>;
}

const appendRoutingText = (parts: string[], value: unknown): void => {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    if (text) parts.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) appendRoutingText(parts, item);
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      appendRoutingText(parts, key);
      appendRoutingText(parts, nested);
    }
  }
};

export const routingText = (values: ReadonlyArray<unknown>): string => {
  const parts: string[] = [];
  for (const value of values) appendRoutingText(parts, value);
  return Array.from(new Set(parts)).join("\n");
};

export const buildMemoryRoutingInput = (input: MemoryRoutingInput): RoutingInput => {
  const metadata = {
    ...(input.metadata ?? {}),
    ...(input.context ?? {}),
  };
  return {
    destination: input.destination,
    cwd: input.cwd,
    content: routingText([input.content, input.entities, metadata, ...(input.extraContent ?? [])]),
    entities: input.entities,
    metadata,
  };
};

export const mergeRoutingInputs = (base: RoutingInput, override?: RoutingInput): RoutingInput => {
  if (!override) return base;
  return {
    destination: override.destination ?? base.destination,
    cwd: override.cwd ?? base.cwd,
    content: routingText([base.content, override.content]),
    entities: Array.from(new Set([...(base.entities ?? []), ...(override.entities ?? [])])),
    metadata: {
      ...(base.metadata ?? {}),
      ...(override.metadata ?? {}),
    },
  };
};
