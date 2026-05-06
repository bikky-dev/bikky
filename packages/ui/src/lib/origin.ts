import crypto from "node:crypto";
import os from "node:os";

import type { BikkyUIConfig } from "./config.js";

export type OriginIdentityType = "user" | "coding_agent" | "daemon" | "ui" | "api" | "cli" | "docs" | "system" | "unknown";
export type OriginIdentitySource = "config" | "shell" | "git" | "env" | "hostname";
export type OriginInterface = "mcp" | "daemon" | "ui" | "api" | "cli" | "system";
export type OriginAction = "create" | "update" | "delete" | "verify" | "forget" | "review" | "correct" | "reinforce" | "supersede" | "feedback";
export type OriginMetadataValue = string | number | boolean | null;

export interface OriginIdentity {
  type: OriginIdentityType;
  id: string | null;
  name: string | null;
  source: OriginIdentitySource;
}

export interface OperationOrigin {
  schema_version: 1;
  user: OriginIdentity | null;
  agent: OriginIdentity;
  interface: OriginInterface;
  operation: {
    action: OriginAction;
    tool?: string;
    route?: string;
    subsystem?: string;
    outcome?: string;
  };
  metadata?: Record<string, OriginMetadataValue>;
}

const hash = (value: string): string =>
  crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 12);

const slug = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

function cleanName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || looksLikeEmail(trimmed)) return null;
  return trimmed.slice(0, 128);
}

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (looksLikeEmail(trimmed)) return `email:${hash(trimmed)}`;
  const normalized = slug(trimmed);
  return normalized || `id:${hash(trimmed)}`;
}

function generatedId(prefix: string, value: string): string {
  if (looksLikeEmail(value)) return `${prefix}:email:${hash(value)}`;
  const normalized = slug(value);
  return normalized ? `${prefix}:${normalized}` : `${prefix}:${hash(value)}`;
}

function hostnameValue(): string {
  const host = os.hostname().trim();
  return host || "unknown-host";
}

function resolveUser(config: BikkyUIConfig): OriginIdentity {
  const configuredName = cleanName(config.identity.user_name);
  const configuredId = normalizeId(config.identity.user_id) ?? (configuredName ? generatedId("user", configuredName) : null);
  if (configuredId || configuredName) {
    return { type: "user", id: configuredId, name: configuredName, source: "config" };
  }

  const envName = cleanName(process.env.BIKKY_USER_NAME);
  const envId = normalizeId(process.env.BIKKY_USER_ID) ?? (envName ? generatedId("user", envName) : null);
  if (envId || envName) {
    return { type: "user", id: envId, name: envName, source: "env" };
  }

  const shellName = cleanName(process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME);
  if (shellName) {
    return { type: "user", id: generatedId("shell", shellName), name: shellName, source: "shell" };
  }

  const host = hostnameValue();
  return { type: "user", id: generatedId("host", host), name: cleanName(host), source: "hostname" };
}

function resolveAgent(type: OriginIdentityType): OriginIdentity {
  const envName = cleanName(process.env.BIKKY_AGENT_NAME);
  const envId = normalizeId(process.env.BIKKY_AGENT_ID) ?? (envName ? generatedId(type, envName) : null);
  if (envId || envName) {
    return { type, id: envId, name: envName, source: "env" };
  }

  const host = hostnameValue();
  return {
    type,
    id: generatedId(type, host),
    name: cleanName(`Bikky ${type} on ${host}`),
    source: "hostname",
  };
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, OriginMetadataValue> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, OriginMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 32)) {
    const normalizedKey = key.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 64);
    if (!normalizedKey) continue;
    if (value === null || typeof value === "boolean") out[normalizedKey] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[normalizedKey] = value;
    else if (typeof value === "string") out[normalizedKey] = value.slice(0, 256);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildOperationOrigin(input: {
  config: BikkyUIConfig;
  action: OriginAction;
  route: string;
  metadata?: Record<string, unknown>;
}): OperationOrigin {
  const origin: OperationOrigin = {
    schema_version: 1,
    user: resolveUser(input.config),
    agent: resolveAgent("ui"),
    interface: "ui",
    operation: {
      action: input.action,
      route: input.route.slice(0, 128),
    },
  };
  const metadata = sanitizeMetadata(input.metadata);
  if (metadata) origin.metadata = metadata;
  return origin;
}
