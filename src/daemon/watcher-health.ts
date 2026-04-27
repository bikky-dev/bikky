/**
 * Watcher path sanity check — flags configurations that will silently
 * produce no extraction work (vanished tempdirs, missing dirs, paths that
 * look like leftover test fixtures).
 *
 * The fix lives outside the watcher itself so daemon startup can warn
 * even before the first extraction tick runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BikkyConfig } from "../config.js";

export interface WatcherPathIssue {
  watcher: string;
  configuredPath: string;
  reasons: string[];
  canonicalDefault: string;
}

const TEMPDIR_PREFIXES = [
  os.tmpdir(),
  "/tmp/",
  "/var/folders/",
  "/private/var/folders/",
  "/private/tmp/",
];

const TEMPDIR_NAME_PATTERNS = [
  /bikky-test-/i,
  /\/T\/TemporaryItems\//,
];

export function looksLikeTempdir(p: string): boolean {
  if (!p) return false;
  const norm = path.resolve(p);
  if (TEMPDIR_PREFIXES.some(prefix => norm.startsWith(prefix))) return true;
  if (TEMPDIR_NAME_PATTERNS.some(re => re.test(norm))) return true;
  return false;
}

function canonicalDefault(watcher: "copilot" | "claude"): string {
  if (watcher === "copilot") return path.join(os.homedir(), ".copilot", "session-state");
  return path.join(os.homedir(), ".claude", "projects");
}

export function inspectWatcherPaths(cfg: BikkyConfig): WatcherPathIssue[] {
  const issues: WatcherPathIssue[] = [];
  const entries: Array<["copilot" | "claude", { enabled: boolean; path: string }]> = [
    ["copilot", cfg.watchers.copilot],
    ["claude", cfg.watchers.claude],
  ];

  for (const [name, w] of entries) {
    if (!w.enabled) continue;
    const reasons: string[] = [];
    const def = canonicalDefault(name);
    const isDefault = path.resolve(w.path) === path.resolve(def);

    if (looksLikeTempdir(w.path)) {
      reasons.push("path is under an OS tempdir — likely leftover from a test run");
    }
    if (!fs.existsSync(w.path)) {
      reasons.push("path does not exist on disk");
    }

    // Only flag as an issue if the path is non-default. A missing default path
    // is normal (e.g. user doesn't use Claude) and not worth warning about.
    if (reasons.length > 0 && !isDefault) {
      issues.push({
        watcher: name,
        configuredPath: w.path,
        reasons,
        canonicalDefault: def,
      });
    }
  }

  return issues;
}

/** Format an issue as a multi-line WARN log message. */
export function formatIssue(issue: WatcherPathIssue): string {
  return [
    `Watcher '${issue.watcher}' path looks broken: ${issue.configuredPath}`,
    `  reasons: ${issue.reasons.join("; ")}`,
    `  canonical default: ${issue.canonicalDefault}`,
    `  fix: edit ~/.bikky/config.json watchers.${issue.watcher}.path, or delete that key to fall back to the default`,
  ].join("\n");
}
