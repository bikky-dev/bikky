import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, "cli.js");

describe("ui/cli", () => {
  it("prints the actual bound URL instead of localhost:0 for ephemeral ports", async () => {
    const child = spawn(process.execPath, [cliPath], {
      env: {
        ...process.env,
        BIKKY_UI_PORT: "0",
        BIKKY_UI_NO_OPEN: "1",
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await waitForOutput(() => stdout.includes("bikky ui running at http://localhost:"));
      assert.equal(stdout.includes("http://localhost:0"), false);
      assert.match(stdout, /bikky ui running at http:\/\/localhost:\d+/);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }

    assert.equal(child.exitCode === 0 || child.signalCode === "SIGTERM", true, stderr);
  });
});

async function waitForOutput(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for bikky-ui to start");
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}
