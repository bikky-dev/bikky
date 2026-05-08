import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  getSessionDestinationOverridePath,
  getStateDir,
  type Destination,
} from "./config.js";
import { DestinationNotFoundError, type RoutingInput } from "./routing.js";

export interface SessionDestinationOverride {
  version: 1;
  destination: string;
  set_at: string;
}

export interface SessionDestinationOverrideStatus {
  path: string;
  exists: boolean;
  active: boolean;
  valid: boolean;
  destination: string | null;
  set_at: string | null;
  error: string | null;
  available_destinations: string[];
}

interface ResolvedSessionDestinationOverride {
  status: SessionDestinationOverrideStatus;
  destination: Destination | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExplicitDestination = (input: RoutingInput): boolean =>
  typeof input.destination === "string" && input.destination.trim() !== "";

function availableNames(destinations: ReadonlyArray<Destination>): string[] {
  return destinations.map((destination) => destination.name);
}

function baseStatus(destinations: ReadonlyArray<Destination>): SessionDestinationOverrideStatus {
  return {
    path: getSessionDestinationOverridePath(),
    exists: false,
    active: false,
    valid: true,
    destination: null,
    set_at: null,
    error: null,
    available_destinations: availableNames(destinations),
  };
}

function parseOverride(raw: unknown): { override: SessionDestinationOverride | null; error: string | null } {
  if (!isRecord(raw)) {
    return { override: null, error: "session destination override file must contain an object" };
  }
  if (raw.version !== 1) {
    return { override: null, error: "unsupported session destination override version" };
  }
  if (typeof raw.destination !== "string" || raw.destination.trim() === "") {
    return { override: null, error: "session destination override destination must be a non-empty string" };
  }
  if (typeof raw.set_at !== "string" || raw.set_at.trim() === "") {
    return { override: null, error: "session destination override set_at must be a non-empty string" };
  }
  return {
    override: {
      version: 1,
      destination: raw.destination.trim(),
      set_at: raw.set_at,
    },
    error: null,
  };
}

export function getSessionDestinationOverrideStatus(
  destinations: ReadonlyArray<Destination>,
): SessionDestinationOverrideStatus {
  return resolveSessionDestinationOverride(destinations).status;
}

export function resolveSessionDestinationOverride(
  destinations: ReadonlyArray<Destination>,
): ResolvedSessionDestinationOverride {
  const status = baseStatus(destinations);
  if (!existsSync(status.path)) return { status, destination: null };

  status.exists = true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(status.path, "utf-8")) as unknown;
  } catch (e) {
    status.valid = false;
    status.error = `failed to read session destination override: ${e instanceof Error ? e.message : String(e)}`;
    return { status, destination: null };
  }

  const { override, error } = parseOverride(parsed);
  if (error || !override) {
    status.valid = false;
    status.error = error ?? "invalid session destination override";
    return { status, destination: null };
  }

  status.destination = override.destination;
  status.set_at = override.set_at;

  const destination = destinations.find((candidate) => candidate.name === override.destination);
  if (!destination) {
    status.valid = false;
    status.error = `unknown destination '${override.destination}'`;
    return { status, destination: null };
  }

  status.active = true;
  return { status, destination };
}

export function applySessionDestinationOverride(
  input: RoutingInput,
  destinations: ReadonlyArray<Destination>,
): RoutingInput {
  if (hasExplicitDestination(input)) return input;
  const resolved = resolveSessionDestinationOverride(destinations);
  if (!resolved.destination) return input;
  return { ...input, destination: resolved.destination.name };
}

export function setSessionDestinationOverride(
  destinationName: string,
  destinations: ReadonlyArray<Destination>,
  now = new Date(),
): SessionDestinationOverrideStatus {
  const wanted = destinationName.trim();
  const destination = destinations.find((candidate) => candidate.name === wanted);
  if (!destination) {
    throw new DestinationNotFoundError(wanted, availableNames(destinations));
  }

  mkdirSync(getStateDir(), { recursive: true });
  const override: SessionDestinationOverride = {
    version: 1,
    destination: destination.name,
    set_at: now.toISOString(),
  };
  writeFileSync(getSessionDestinationOverridePath(), JSON.stringify(override, null, 2) + "\n", "utf-8");
  return getSessionDestinationOverrideStatus(destinations);
}

export function clearSessionDestinationOverride(): { path: string; cleared: boolean } {
  const path = getSessionDestinationOverridePath();
  if (!existsSync(path)) return { path, cleared: false };
  rmSync(path, { force: true });
  return { path, cleared: true };
}
