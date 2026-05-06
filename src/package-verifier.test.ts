import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertPackageContents,
  assertSafeTextContent,
  findForbiddenContent,
  findForbiddenPath,
  normalizePackPath,
  shouldScanTextByMetadata,
} from "./package-verifier.js";

describe("package verifier helpers", () => {
  it("normalizes npm pack paths before package content checks", () => {
    assert.equal(normalizePackPath("package/dist/cli.js"), "dist/cli.js");
    assert.equal(normalizePackPath("dist/cli.js"), "dist/cli.js");
  });

  it("requires public package files and rejects forbidden paths", () => {
    assertPackageContents(
      { name: "bikky", requiredPaths: ["README.md", "dist/cli.js"] },
      ["README.md", "dist/cli.js"],
    );

    assert.throws(
      () => assertPackageContents(
        { name: "bikky", requiredPaths: ["README.md", "dist/cli.js"] },
        ["README.md"],
      ),
      /missing required file: dist\/cli\.js/,
    );

    assert.throws(
      () => assertPackageContents(
        { name: "bikky", requiredPaths: ["README.md"] },
        ["README.md", "dist/cli.test.js"],
      ),
      /compiled test artifacts/,
    );
  });

  it("identifies forbidden path and text patterns used by package verification", () => {
    assert.equal(findForbiddenPath("tasks/003-test-hardening/plan.md")?.reason, "task, node_modules, or git metadata");
    assert.equal(findForbiddenPath("dist/cli.js"), null);

    assert.equal(findForbiddenContent("token=ghp_abcdefghijklmnopqrstuvwxyz")?.reason, "GitHub token");
    assert.equal(findForbiddenContent("public README text"), null);
  });

  it("scans only small package text assets", () => {
    assert.equal(shouldScanTextByMetadata("dist/index.js", 10), true);
    assert.equal(shouldScanTextByMetadata("dist/index.d.ts", 10), true);
    assert.equal(shouldScanTextByMetadata("dist/image.png", 10), false);
    assert.equal(shouldScanTextByMetadata("README.md", 2_000_001), false);
  });

  it("reports the offending text file when package content is unsafe", () => {
    assert.throws(
      () => assertSafeTextContent("bikky", "README.md", "private path /Users/saber/config"),
      /forbidden content \(local user path\) in README\.md/,
    );
  });
});

