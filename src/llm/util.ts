/**
 * Tiny helpers shared by the embedding and inference layers.
 */

/**
 * Returns the first argument that is a non-empty trimmed string, or undefined.
 *
 * Useful when a value may come from a config layer that normalises absent
 * fields to `""` instead of leaving them undefined — `??` alone won't fall
 * through `""`, but this will. See issue #131.
 */
export function firstNonEmptyString(...candidates: Array<string | undefined | null>): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return undefined;
}
