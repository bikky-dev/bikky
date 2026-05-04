import type { BikkyConfig, Destination, SearchScopeTarget } from "./config.js";
import { resolveDestination, type RoutingInput } from "./routing.js";

export type SearchScopeInput = SearchScopeTarget | null | undefined;

export interface AvailableSearchScope {
  name: string;
  description: string;
  destinations: "routed" | "all" | string[];
  default: boolean;
  source: "builtin" | "destination" | "config";
}

export interface ResolvedSearchScope {
  name: string;
  description: string;
  requested: SearchScopeTarget;
  destinations: Destination[];
}

export class SearchScopeNotFoundError extends Error {
  constructor(
    public readonly scope: string,
    public readonly available: string[],
  ) {
    super(`Unknown search scope '${scope}'. Available scopes: ${available.length > 0 ? available.join(", ") : "(none)"}`);
    this.name = "SearchScopeNotFoundError";
  }
}

function normalizeString(value: string): string {
  return value.trim();
}

function normalizeTarget(target: SearchScopeInput): SearchScopeTarget | null {
  if (Array.isArray(target)) {
    const normalized = target.map(normalizeString).filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  }
  if (typeof target === "string") {
    const trimmed = normalizeString(target);
    if (!trimmed) return null;
    if (trimmed.includes(",")) {
      const names = trimmed.split(",").map(normalizeString).filter(Boolean);
      if (names.length > 1) return names;
    }
    return trimmed;
  }
  return null;
}

function targetEquals(a: SearchScopeTarget | null, b: SearchScopeTarget | null): boolean {
  const normalizedA = normalizeTarget(a);
  const normalizedB = normalizeTarget(b);
  if (Array.isArray(normalizedA) || Array.isArray(normalizedB)) {
    if (!Array.isArray(normalizedA) || !Array.isArray(normalizedB)) return false;
    if (normalizedA.length !== normalizedB.length) return false;
    return normalizedA.every((value, idx) => value === normalizedB[idx]);
  }
  return normalizedA === normalizedB;
}

function describeTarget(target: SearchScopeTarget): "routed" | "all" | string[] {
  const normalized = normalizeTarget(target) ?? "routed";
  if (Array.isArray(normalized)) return normalized;
  if (normalized === "routed" || normalized === "all") return normalized;
  return [normalized];
}

function destinationScopeDescription(destination: Destination): string {
  return destination.description
    ?? `Search only the '${destination.name}' destination (collection '${destination.collection}').`;
}

export function availableSearchScopes(
  config: BikkyConfig,
  destinations: ReadonlyArray<Destination>,
): AvailableSearchScope[] {
  const defaultScope = normalizeTarget(config.default_search_scope) ?? "routed";
  const scopes: AvailableSearchScope[] = [
    {
      name: "routed",
      description: "Search the single destination selected by the routing rules (cwd, query/content, entities, metadata), then default/first destination fallback. This preserves historical behavior and keeps destination boundaries narrow.",
      destinations: "routed",
      default: targetEquals(defaultScope, "routed"),
      source: "builtin",
    },
    {
      name: "all",
      description: "Search every configured destination and merge/rerank the results. Use for broad recall when relevant context may span multiple memory stores.",
      destinations: "all",
      default: targetEquals(defaultScope, "all"),
      source: "builtin",
    },
  ];

  for (const destination of destinations) {
    scopes.push({
      name: destination.name,
      description: destinationScopeDescription(destination),
      destinations: [destination.name],
      default: targetEquals(defaultScope, destination.name),
      source: "destination",
    });
  }

  for (const scope of config.search_scopes) {
    scopes.push({
      name: scope.name,
      description: scope.description,
      destinations: describeTarget(scope.destinations),
      default: targetEquals(defaultScope, scope.name) || targetEquals(defaultScope, scope.destinations),
      source: "config",
    });
  }

  return scopes;
}

function resolveNames(
  names: ReadonlyArray<string>,
  destinations: ReadonlyArray<Destination>,
): Destination[] {
  const byName = new Map(destinations.map((destination) => [destination.name, destination]));
  const resolved: Destination[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = normalizeString(rawName);
    if (!name || seen.has(name)) continue;
    const destination = byName.get(name);
    if (!destination) throw new SearchScopeNotFoundError(name, [...byName.keys()]);
    resolved.push(destination);
    seen.add(name);
  }
  if (resolved.length === 0) {
    throw new SearchScopeNotFoundError(names.join(","), [...byName.keys()]);
  }
  return resolved;
}

function resolveTarget(
  target: SearchScopeTarget,
  config: BikkyConfig,
  destinations: ReadonlyArray<Destination>,
  routing: RoutingInput,
  depth = 0,
): ResolvedSearchScope {
  if (depth > 4) {
    throw new Error("Search scope resolution exceeded maximum nesting depth");
  }

  const normalized = normalizeTarget(target) ?? "routed";
  if (Array.isArray(normalized)) {
    const resolved = resolveNames(normalized, destinations);
    return {
      name: normalized.join(","),
      description: `Search selected destinations: ${normalized.join(", ")}.`,
      requested: normalized,
      destinations: resolved,
    };
  }

  const configuredScope = config.search_scopes.find((scope) => scope.name === normalized);
  if (configuredScope) {
    const resolved = resolveTarget(configuredScope.destinations, config, destinations, routing, depth + 1);
    return {
      name: configuredScope.name,
      description: configuredScope.description,
      requested: normalized,
      destinations: resolved.destinations,
    };
  }

  if (normalized === "routed" || normalized === "auto") {
    const destination = resolveDestination(routing, destinations);
    return {
      name: "routed",
      description: "Search the single destination selected by routing rules.",
      requested: normalized,
      destinations: [destination],
    };
  }

  if (normalized === "all") {
    if (destinations.length === 0) {
      resolveDestination(routing, destinations);
    }
    return {
      name: "all",
      description: "Search every configured destination.",
      requested: normalized,
      destinations: [...destinations],
    };
  }

  const destination = destinations.find((dest) => dest.name === normalized);
  if (destination) {
    return {
      name: destination.name,
      description: destinationScopeDescription(destination),
      requested: normalized,
      destinations: [destination],
    };
  }

  const available = availableSearchScopes(config, destinations).map((scope) => scope.name);
  throw new SearchScopeNotFoundError(normalized, available);
}

export function resolveSearchScope(
  input: SearchScopeInput,
  config: BikkyConfig,
  destinations: ReadonlyArray<Destination>,
  routing: RoutingInput,
): ResolvedSearchScope {
  const target = normalizeTarget(input) ?? normalizeTarget(config.default_search_scope) ?? "routed";
  return resolveTarget(target, config, destinations, routing);
}
