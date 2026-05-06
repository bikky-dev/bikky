import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf-8")) as T;
}

interface PackageJson {
  files?: string[];
  scripts?: Record<string, string>;
  bin?: Record<string, string>;
}

describe("package metadata safety", () => {
  it("keeps compiled tests and task artifacts out of the root npm package", () => {
    const pkg = readJson<PackageJson>("package.json");

    assert.ok(pkg.files?.includes("!dist/**/*.test.js"));
    assert.ok(pkg.files?.includes("!dist/**/*.test.d.ts"));
    assert.ok(pkg.files?.includes("!dist/**/*.itest.js"));
    assert.ok(pkg.files?.includes("!dist/**/*.itest.d.ts"));
    assert.equal(pkg.files?.some((entry) => entry.startsWith("tasks")), false);
    assert.equal(pkg.bin?.bikky, "bin/bikky.js");
    assert.equal(pkg.scripts?.["verify:package"], "node scripts/verify-package.mjs");
  });

  it("ships the public docs required by README npm links", () => {
    const pkg = readJson<PackageJson>("package.json");

    for (const required of [
      "CONTRIBUTING.md",
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "SUPPORT.md",
      "CHANGELOG.md",
      "docs/config/",
      "docs/diagrams/",
      "docs/screenshots/",
    ]) {
      assert.ok(pkg.files?.includes(required), `missing ${required}`);
    }
  });

  it("keeps UI package metadata aligned with package verification", () => {
    const pkg = readJson<PackageJson>("packages/ui/package.json");

    assert.ok(pkg.files?.includes("README.md"));
    assert.ok(pkg.files?.includes("LICENSE"));
    assert.ok(pkg.files?.includes("dist/public/"));
    assert.ok(pkg.files?.includes("!dist/**/*.test.js"));
    assert.ok(pkg.files?.includes("!dist/**/*.test.d.ts"));
    assert.equal(pkg.bin?.["bikky-ui"], "bin/bikky-ui.js");
  });
});
