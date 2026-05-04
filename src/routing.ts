/**
 * Pure destination routing.
 *
 * Resolves which `Destination` a memory operation should target based on
 * caller-supplied input (entities, content, metadata) and the current cwd.
 *
 * Resolution order:
 *   1. Explicit override — if `input.destination` is set, the destination with
 *      that name is returned. Throws if no such destination exists.
 *   2. Match scan — destinations are walked in array order. For each, ANY
 *      regex matching ANY field in the destination's `match` block wins
 *      (OR semantics). First matching destination wins.
 *   3. Default fallback — destination with `default: true`, else the first
 *      destination in the array.
 *
 * Pure: no I/O, no globals. Easy to unit test.
 */
import type { Destination, DestinationMatch } from "./config.js";

export interface RoutingInput {
  /** Explicit destination name override. Throws if it doesn't match a destination. */
  destination?: string | null;
  /** Current working directory. Defaults to `process.cwd()` if omitted by caller. */
  cwd?: string;
  /** Entity names mentioned by the operation. */
  entities?: ReadonlyArray<string>;
  /** Free-text content (e.g. memory_store content, memory_recall query). */
  content?: string | null;
  /** Caller-provided metadata map. */
  metadata?: Record<string, unknown> | null;
}

export class DestinationNotFoundError extends Error {
  constructor(public readonly name: string, public readonly available: string[]) {
    super(
      `Unknown destination '${name}'. Configured destinations: ${available.length > 0 ? available.join(", ") : "(none)"}`,
    );
    this.name = "DestinationNotFoundError";
  }
}

export class NoDestinationsConfiguredError extends Error {
  constructor() {
    super("No destinations configured. Set top-level qdrant_url or destinations[] in ~/.bikky/config.json.");
    this.name = "NoDestinationsConfiguredError";
  }
}

/** Pre-compile all regexes in a destination's match block. */
interface CompiledMatch {
  cwd: RegExp[];
  entity: RegExp[];
  content: RegExp[];
  metadata: Record<string, RegExp[]>;
}

interface CompiledDestination {
  destination: Destination;
  compiled: CompiledMatch;
}

function compileArray(patterns: ReadonlyArray<string> | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  return patterns.map((p) => new RegExp(p));
}

function compileMatch(match: DestinationMatch | undefined): CompiledMatch {
  const m: CompiledMatch = { cwd: [], entity: [], content: [], metadata: {} };
  if (!match) return m;
  m.cwd = compileArray(match.cwd);
  m.entity = compileArray(match.entity);
  m.content = compileArray(match.content);
  if (match.metadata) {
    for (const [k, v] of Object.entries(match.metadata)) {
      m.metadata[k] = compileArray(v);
    }
  }
  return m;
}

function compileDestinations(destinations: ReadonlyArray<Destination>): CompiledDestination[] {
  return destinations.map((destination) => ({
    destination,
    compiled: compileMatch(destination.match),
  }));
}

function anyMatches(value: string, patterns: ReadonlyArray<RegExp>): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((re) => re.test(value));
}

function destinationMatches(compiled: CompiledMatch, input: RoutingInput): boolean {
  const cwd = input.cwd ?? "";
  if (cwd && anyMatches(cwd, compiled.cwd)) return true;

  if (input.entities && input.entities.length > 0 && compiled.entity.length > 0) {
    for (const entity of input.entities) {
      if (anyMatches(entity, compiled.entity)) return true;
    }
  }

  if (input.content && compiled.content.length > 0 && anyMatches(input.content, compiled.content)) {
    return true;
  }

  if (input.metadata && Object.keys(compiled.metadata).length > 0) {
    for (const [key, patterns] of Object.entries(compiled.metadata)) {
      const raw = input.metadata[key];
      if (raw === undefined || raw === null) continue;
      const value = typeof raw === "string" ? raw : String(raw);
      if (anyMatches(value, patterns)) return true;
    }
  }

  return false;
}

function pickFallback(destinations: ReadonlyArray<Destination>): Destination {
  const explicit = destinations.find((d) => d.default === true);
  if (explicit) return explicit;
  return destinations[0];
}

/**
 * Resolve a destination from caller input + a (pre-loaded) list of destinations.
 *
 * Throws `NoDestinationsConfiguredError` if `destinations` is empty.
 * Throws `DestinationNotFoundError` if `input.destination` doesn't match a
 * configured destination.
 */
export function resolveDestination(
  input: RoutingInput,
  destinations: ReadonlyArray<Destination>,
): Destination {
  if (destinations.length === 0) throw new NoDestinationsConfiguredError();

  if (input.destination && input.destination.trim() !== "") {
    const wanted = input.destination.trim();
    const found = destinations.find((d) => d.name === wanted);
    if (!found) {
      throw new DestinationNotFoundError(wanted, destinations.map((d) => d.name));
    }
    return found;
  }

  const compiled = compileDestinations(destinations);
  for (const entry of compiled) {
    if (destinationMatches(entry.compiled, input)) return entry.destination;
  }

  return pickFallback(destinations);
}

/**
 * Pre-compile a routing table for hot paths (e.g. per-tick in the daemon).
 * Returns a closure that resolves a destination from input without recompiling
 * regexes on every call.
 */
export function buildResolver(
  destinations: ReadonlyArray<Destination>,
): (input: RoutingInput) => Destination {
  if (destinations.length === 0) {
    return (): Destination => { throw new NoDestinationsConfiguredError(); };
  }
  const compiled = compileDestinations(destinations);
  return (input: RoutingInput): Destination => {
    if (input.destination && input.destination.trim() !== "") {
      const wanted = input.destination.trim();
      const found = destinations.find((d) => d.name === wanted);
      if (!found) {
        throw new DestinationNotFoundError(wanted, destinations.map((d) => d.name));
      }
      return found;
    }
    for (const entry of compiled) {
      if (destinationMatches(entry.compiled, input)) return entry.destination;
    }
    return pickFallback(destinations);
  };
}
