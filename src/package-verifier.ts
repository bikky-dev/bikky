import fs from "node:fs";
import path from "node:path";

export interface PackageVerifierPattern {
  re: RegExp;
  reason: string;
}

export interface PackageVerifierSpec {
  name: string;
  requiredPaths: string[];
}

const privateIdentityPathPattern = (): RegExp => new RegExp([
  ["saber", "zrelli", "private"].join("-"),
  ["saber", "apate"].join("-"),
  "ap" + "ate",
].join("|"), "i");

const privateIdentityContentPattern = (): RegExp => new RegExp([
  ["saber", "zrelli", "private"].join("-"),
  ["saber", "apate"].join("-"),
  ["apate", "ai"].join("-"),
  ["apate", "com"].join("\\."),
].join("|"), "i");

export const TEXT_EXTENSIONS = new Set([
  ".css",
  ".d.ts",
  ".html",
  ".js",
  ".json",
  ".md",
  ".svg",
  ".txt",
]);

export const FORBIDDEN_PATH_PATTERNS: PackageVerifierPattern[] = [
  { re: /(^|\/)(tasks|node_modules|\.git)(\/|$)/, reason: "task, node_modules, or git metadata" },
  { re: /(^|\/)\.env($|\.)/, reason: "environment files" },
  { re: /(\.test|\.itest)\.(js|d\.ts)$/i, reason: "compiled test artifacts" },
  { re: /(^|\/)(id_rsa|id_ed25519|.*\.pem|.*\.key)$/i, reason: "private key material" },
  { re: /(^|\/)Users\/|\/Users\//i, reason: "absolute local user paths" },
  { re: privateIdentityPathPattern(), reason: "private identity references" },
];

export const FORBIDDEN_CONTENT_PATTERNS: PackageVerifierPattern[] = [
  { re: /gh[pousr]_[A-Za-z0-9_]{20,}/, reason: "GitHub token" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/, reason: "GitHub fine-grained token" },
  { re: /sk-[A-Za-z0-9]{20,}/, reason: "OpenAI-style API key" },
  { re: /AKIA[0-9A-Z]{16}/, reason: "AWS access key id" },
  { re: /AIza[0-9A-Za-z_-]{35}/, reason: "Google API key" },
  { re: /xox[baprs]-[0-9A-Za-z-]{20,}/, reason: "Slack token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "private key block" },
  { re: /\/Users\/saber\b/i, reason: "local user path" },
  { re: privateIdentityContentPattern(), reason: "private identity reference" },
];

export function normalizePackPath(file: string): string {
  return file.replace(/^package\//, "");
}

export function findForbiddenPath(
  file: string,
  patterns: ReadonlyArray<PackageVerifierPattern> = FORBIDDEN_PATH_PATTERNS,
): PackageVerifierPattern | null {
  return patterns.find(({ re }) => re.test(file)) ?? null;
}

export function findForbiddenContent(
  content: string,
  patterns: ReadonlyArray<PackageVerifierPattern> = FORBIDDEN_CONTENT_PATTERNS,
): PackageVerifierPattern | null {
  return patterns.find(({ re }) => re.test(content)) ?? null;
}

export function assertPackageContents(
  pkg: PackageVerifierSpec,
  files: string[],
  patterns: ReadonlyArray<PackageVerifierPattern> = FORBIDDEN_PATH_PATTERNS,
): void {
  const fileSet = new Set(files);
  for (const requiredPath of pkg.requiredPaths) {
    if (!fileSet.has(requiredPath)) {
      throw new Error(`${pkg.name} package is missing required file: ${requiredPath}`);
    }
  }

  for (const file of files) {
    const forbidden = findForbiddenPath(file, patterns);
    if (forbidden) {
      throw new Error(`${pkg.name} package includes forbidden path (${forbidden.reason}): ${file}`);
    }
  }
}

export function shouldScanTextByMetadata(
  file: string,
  size: number,
  textExtensions: ReadonlySet<string> = TEXT_EXTENSIONS,
): boolean {
  if (size > 2_000_000) return false;
  const lower = file.toLowerCase();
  if (lower.endsWith(".d.ts")) return true;
  return textExtensions.has(path.extname(lower));
}

export function shouldScanText(file: string): boolean {
  return shouldScanTextByMetadata(file, fs.statSync(file).size);
}

export function assertSafeTextContent(pkgName: string, relPath: string, content: string): void {
  const forbidden = findForbiddenContent(content);
  if (forbidden) {
    throw new Error(`${pkgName} package includes forbidden content (${forbidden.reason}) in ${relPath}`);
  }
}
