import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-cli-smoke-"));

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): RunResult {
  const { FORCE_COLOR: _forceColor, ...baseEnv } = process.env;
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    env: {
      ...baseEnv,
      BIKKY_HOME: testHome,
      CI: "1",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("CLI smoke commands", () => {
  before(() => {
    fs.mkdirSync(testHome, { recursive: true });
  });

  after(() => {
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it("prints a version without booting long-running services", () => {
    const result = runCli(["--version"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^bikky v\d+\.\d+\.\d+/);
  });

  it("prints render help as a short-lived subprocess", () => {
    const result = runCli(["render", "--help"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Usage:/);
    assert.match(result.stdout, /bikky render <name>/);
  });

  it("prints status JSON without live service checks", () => {
    const result = runCli(["status", "--json", "--no-live", "--no-ui"]);

    assert.ok(result.status === 0 || result.status === 1);
    const body = JSON.parse(result.stdout) as { ok: boolean; config?: { status?: string } };
    assert.equal(typeof body.ok, "boolean");
    assert.ok(body.config);
  });

  it("rejects unknown commands with a helpful error", () => {
    const result = runCli(["not-a-command"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command: not-a-command/);
  });
});
