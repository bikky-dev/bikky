import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { BikkyConfig } from "../config.js";

export interface ActorIdentity {
  actor_id?: string;
  actor_label?: string;
  source?: "input" | "config" | "env" | "git";
}

export interface ResolveActorOptions {
  actorId?: string | null;
  actorLabel?: string | null;
  config?: BikkyConfig | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  useGitFallback?: boolean;
}

const hash = (value: string): string =>
  crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 12);

const slug = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export function normalizeActorId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (looksLikeEmail(trimmed)) return `email:${hash(trimmed)}`;
  const normalized = slug(trimmed);
  return normalized || `actor:${hash(trimmed)}`;
}

function cleanLabel(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || looksLikeEmail(trimmed)) return undefined;
  return trimmed.slice(0, 128);
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

export function resolveActorIdentity(options: ResolveActorOptions = {}): ActorIdentity {
  const env = options.env ?? process.env;
  const fromInput = normalizeActorId(options.actorId);
  if (fromInput) {
    return {
      actor_id: fromInput,
      actor_label: cleanLabel(options.actorLabel),
      source: "input",
    };
  }

  const fromEnv = normalizeActorId(env.BIKKY_ACTOR_ID);
  if (fromEnv) {
    return {
      actor_id: fromEnv,
      actor_label: cleanLabel(env.BIKKY_ACTOR_LABEL),
      source: "env",
    };
  }

  const fromConfig = normalizeActorId(options.config?.identity.actor_id);
  if (fromConfig) {
    return {
      actor_id: fromConfig,
      actor_label: cleanLabel(options.config?.identity.actor_label),
      source: "config",
    };
  }

  if (options.useGitFallback === false) return {};

  const gitName = readGitConfig("user.name", options.cwd);
  const gitEmail = readGitConfig("user.email", options.cwd);
  const nameSlug = slug(gitName ?? "");
  if (gitEmail) {
    return {
      actor_id: nameSlug ? `git:${nameSlug}:${hash(gitEmail)}` : `git:${hash(gitEmail)}`,
      actor_label: cleanLabel(gitName),
      source: "git",
    };
  }
  if (nameSlug) {
    return {
      actor_id: `git:${nameSlug}`,
      actor_label: cleanLabel(gitName),
      source: "git",
    };
  }

  return {};
}
