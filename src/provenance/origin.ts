import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";

import type { BikkyConfig } from "../config.js";

export type OriginIdentityType =
  | "user"
  | "coding_agent"
  | "daemon"
  | "ui"
  | "api"
  | "cli"
  | "docs"
  | "system"
  | "unknown";

export type OriginIdentitySource = "config" | "shell" | "git" | "env" | "hostname";

export type OriginInterface = "mcp" | "daemon" | "ui" | "api" | "cli" | "system";

export type OriginAction =
  | "create"
  | "update"
  | "delete"
  | "verify"
  | "forget"
  | "review"
  | "correct"
  | "reinforce"
  | "supersede"
  | "recall"
  | "aggregate"
  | "feedback";

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

export interface ResolveUserIdentityOptions {
  config?: Pick<BikkyConfig, "identity"> | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  hostname?: string;
  shellUsername?: string | null;
}

export interface ResolveAgentIdentityOptions {
  type?: OriginIdentityType;
  interface?: OriginInterface;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
}

export interface BuildOperationOriginInput extends ResolveUserIdentityOptions {
  interface: OriginInterface;
  action: OriginAction;
  tool?: string;
  route?: string;
  subsystem?: string;
  outcome?: string;
  agentType?: OriginIdentityType;
  metadata?: Record<string, unknown>;
}

const MAX_NAME_LENGTH = 128;
const MAX_OPERATION_FIELD_LENGTH = 128;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_STRING_LENGTH = 256;

const hash = (value: string): string =>
  crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 12);

const slug = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

const cleanName = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed || looksLikeEmail(trimmed)) return null;
  return trimmed.slice(0, MAX_NAME_LENGTH);
};

const cleanOperationField = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_OPERATION_FIELD_LENGTH) : undefined;
};

export function normalizeOriginId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (looksLikeEmail(trimmed)) return `email:${hash(trimmed)}`;
  const normalized = slug(trimmed);
  return normalized || `id:${hash(trimmed)}`;
}

function generatedId(prefix: string, value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (looksLikeEmail(trimmed)) return `${prefix}:email:${hash(trimmed)}`;
  const normalized = slug(trimmed);
  return normalized ? `${prefix}:${normalized}` : `${prefix}:${hash(trimmed)}`;
}

function configuredIdentity(
  type: OriginIdentityType,
  rawId: string | null | undefined,
  rawName: string | null | undefined,
  source: OriginIdentitySource,
): OriginIdentity | null {
  const name = cleanName(rawName);
  const id = normalizeOriginId(rawId) ?? (name ? generatedId(type === "user" ? "user" : type, name) : null);
  if (!id && !name) return null;
  return { type, id, name, source };
}

function readGitConfig(key: "user.name" | "user.email", cwd?: string): string | undefined {
  try {
    const value = execFileSync("git", ["config", "--get", key], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function gitUserIdentity(cwd?: string): OriginIdentity | null {
  const gitName = readGitConfig("user.name", cwd);
  const gitEmail = readGitConfig("user.email", cwd);
  const nameSlug = slug(gitName ?? "");
  if (gitEmail) {
    return {
      type: "user",
      id: nameSlug ? `git:${nameSlug}:${hash(gitEmail)}` : `git:${hash(gitEmail)}`,
      name: cleanName(gitName),
      source: "git",
    };
  }
  if (nameSlug) {
    return {
      type: "user",
      id: `git:${nameSlug}`,
      name: cleanName(gitName),
      source: "git",
    };
  }
  return null;
}

function shellUserName(options: ResolveUserIdentityOptions): string | null {
  if (Object.prototype.hasOwnProperty.call(options, "shellUsername") && options.shellUsername === null) {
    return null;
  }
  const explicit = cleanName(options.shellUsername);
  if (explicit) return explicit;
  try {
    const user = os.userInfo().username;
    const cleaned = cleanName(user);
    if (cleaned) return cleaned;
  } catch {
    // ignore and fall through to env-derived shell names
  }
  const env = options.env ?? process.env;
  return cleanName(env.USER ?? env.LOGNAME ?? env.USERNAME);
}

function hostnameValue(hostname?: string): string {
  const explicit = hostname?.trim();
  if (explicit) return explicit;
  const detected = os.hostname().trim();
  return detected || "unknown-host";
}

function hostnameIdentity(type: OriginIdentityType, hostname?: string, prefix?: string): OriginIdentity {
  const host = hostnameValue(hostname);
  return {
    type,
    id: generatedId(prefix ?? "host", host),
    name: cleanName(host),
    source: "hostname",
  };
}

export function resolveUserIdentity(options: ResolveUserIdentityOptions = {}): OriginIdentity {
  const env = options.env ?? process.env;
  const fromConfig = configuredIdentity(
    "user",
    options.config?.identity.user_id,
    options.config?.identity.user_name,
    "config",
  );
  if (fromConfig) return fromConfig;

  const fromEnv = configuredIdentity("user", env.BIKKY_USER_ID, env.BIKKY_USER_NAME, "env");
  if (fromEnv) return fromEnv;

  const fromGit = gitUserIdentity(options.cwd);
  if (fromGit) return fromGit;

  const shellName = shellUserName(options);
  if (shellName) {
    return {
      type: "user",
      id: generatedId("shell", shellName),
      name: shellName,
      source: "shell",
    };
  }

  return hostnameIdentity("user", options.hostname);
}

export function inferUserIdentity(options: Omit<ResolveUserIdentityOptions, "config"> = {}): OriginIdentity {
  return resolveUserIdentity({ ...options, config: null });
}

function defaultAgentType(originInterface: OriginInterface): OriginIdentityType {
  switch (originInterface) {
    case "mcp":
      return "coding_agent";
    case "daemon":
      return "daemon";
    case "ui":
      return "ui";
    case "api":
      return "api";
    case "cli":
      return "cli";
    case "system":
      return "system";
  }
}

function defaultAgentName(type: OriginIdentityType, originInterface?: OriginInterface): string {
  if (type === "coding_agent" && originInterface === "mcp") return "Bikky MCP client";
  if (type === "daemon") return "Bikky daemon";
  if (type === "ui") return "Bikky UI";
  if (type === "api") return "Bikky API";
  if (type === "cli") return "Bikky CLI";
  if (type === "system") return "Bikky system";
  if (type === "docs") return "Bikky docs importer";
  return "Bikky";
}

export function resolveAgentIdentity(options: ResolveAgentIdentityOptions = {}): OriginIdentity {
  const env = options.env ?? process.env;
  const type = options.type ?? (options.interface ? defaultAgentType(options.interface) : "unknown");
  const envIdentity = configuredIdentity(
    type,
    env.BIKKY_AGENT_ID,
    env.BIKKY_AGENT_NAME,
    "env",
  );
  if (envIdentity) return envIdentity;

  const host = hostnameValue(options.hostname);
  return {
    type,
    id: generatedId(type, host),
    name: cleanName(`${defaultAgentName(type, options.interface)} on ${host}`),
    source: "hostname",
  };
}

export function sanitizeOriginMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, OriginMetadataValue> | undefined {
  if (!metadata) return undefined;
  const sanitized: Record<string, OriginMetadataValue> = {};
  for (const [rawKey, rawValue] of Object.entries(metadata).slice(0, MAX_METADATA_KEYS)) {
    const key = rawKey.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, MAX_METADATA_KEY_LENGTH);
    if (!key) continue;
    if (rawValue === null || typeof rawValue === "boolean") {
      sanitized[key] = rawValue;
    } else if (typeof rawValue === "number") {
      if (Number.isFinite(rawValue)) sanitized[key] = rawValue;
    } else if (typeof rawValue === "string") {
      sanitized[key] = rawValue.slice(0, MAX_METADATA_STRING_LENGTH);
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function buildOperationOrigin(input: BuildOperationOriginInput): OperationOrigin {
  const operation: OperationOrigin["operation"] = {
    action: input.action,
  };
  const tool = cleanOperationField(input.tool);
  const route = cleanOperationField(input.route);
  const subsystem = cleanOperationField(input.subsystem);
  const outcome = cleanOperationField(input.outcome);
  if (tool) operation.tool = tool;
  if (route) operation.route = route;
  if (subsystem) operation.subsystem = subsystem;
  if (outcome) operation.outcome = outcome;

  const origin: OperationOrigin = {
    schema_version: 1,
    user: resolveUserIdentity(input),
    agent: resolveAgentIdentity({
      type: input.agentType,
      interface: input.interface,
      env: input.env,
      hostname: input.hostname,
    }),
    interface: input.interface,
    operation,
  };
  const metadata = sanitizeOriginMetadata(input.metadata);
  if (metadata) origin.metadata = metadata;
  return origin;
}

export function isOperationOrigin(value: unknown): value is OperationOrigin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OperationOrigin>;
  return candidate.schema_version === 1
    && Boolean(candidate.agent)
    && typeof candidate.interface === "string"
    && Boolean(candidate.operation)
    && typeof candidate.operation?.action === "string";
}
