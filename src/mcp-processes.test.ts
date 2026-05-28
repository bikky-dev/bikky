import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isBikkyMcpCommand,
  parsePsOutput,
  reportRunningBikkyMcpServers,
  splitCommandLine,
  type McpProcessDetectionResult,
} from "./mcp-processes.js";

const processes = (...pids: number[]): McpProcessDetectionResult => ({
  processes: pids.map((pid) => ({ pid, command: `npx -y bikky mcp # ${pid}` })),
});

const logger = (): Pick<Console, "log" | "warn"> & { lines: string[]; warnings: string[] } => {
  const lines: string[] = [];
  const warnings: string[] = [];
  return {
    lines,
    warnings,
    log: (message?: unknown): void => {
      lines.push(String(message ?? ""));
    },
    warn: (message?: unknown): void => {
      warnings.push(String(message ?? ""));
    },
  };
};

describe("MCP process detection", () => {
  it("splits shell-like command lines", () => {
    assert.deepStrictEqual(splitCommandLine("npx -y 'bikky@latest' mcp"), ["npx", "-y", "bikky@latest", "mcp"]);
    assert.deepStrictEqual(splitCommandLine('node "/tmp/node_modules/bikky/bin/bikky.js" mcp'), [
      "node",
      "/tmp/node_modules/bikky/bin/bikky.js",
      "mcp",
    ]);
  });

  it("matches common bikky mcp invocations", () => {
    assert.equal(isBikkyMcpCommand("bikky mcp"), true);
    assert.equal(isBikkyMcpCommand("npx -y bikky mcp"), true);
    assert.equal(isBikkyMcpCommand("npx --yes bikky@latest mcp"), true);
    assert.equal(isBikkyMcpCommand("node /Users/saber/code/bikky/dist/cli.js mcp"), true);
    assert.equal(isBikkyMcpCommand("node /tmp/node_modules/bikky/bin/bikky.js mcp"), true);
  });

  it("does not match non-Bikky MCP servers or other bikky commands", () => {
    assert.equal(isBikkyMcpCommand("github-mcp-server stdio"), false);
    assert.equal(isBikkyMcpCommand("npx -y filesystem-mcp mcp"), false);
    assert.equal(isBikkyMcpCommand("bikky setup"), false);
    assert.equal(isBikkyMcpCommand("bikky daemon"), false);
  });

  it("parses ps output and skips the current process", () => {
    const output = `
      111 npx -y bikky mcp
      222 github-mcp-server stdio
      333 bikky setup
      444 node /tmp/node_modules/bikky/bin/bikky.js mcp
    `;

    assert.deepStrictEqual(parsePsOutput(output, 444), [
      { pid: 111, command: "npx -y bikky mcp" },
    ]);
  });
});

describe("reportRunningBikkyMcpServers", () => {
  it("reports detected bikky MCP processes with reload guidance", () => {
    const logs = logger();

    const result = reportRunningBikkyMcpServers({
      detectProcesses: () => processes(123, 456),
      logger: logs,
    });

    assert.deepStrictEqual(result, { detected: 2 });
    assert.match(logs.lines.join("\n"), /Found 2 running bikky MCP server processes/);
    assert.match(logs.warnings.join("\n"), /does not terminate client-owned MCP server processes/);
    assert.match(logs.warnings.join("\n"), /GitHub Copilot CLI users should run \/restart/);
    assert.match(logs.warnings.join("\n"), /Claude Code users should restart Claude Code/);
  });

  it("does not prompt or terminate processes", () => {
    const logs = logger();

    const result = reportRunningBikkyMcpServers({
      detectProcesses: () => processes(123),
      logger: logs,
    });

    assert.deepStrictEqual(result, { detected: 1 });
    assert.doesNotMatch(logs.lines.concat(logs.warnings).join("\n"), /Type y|yes to continue|Terminated/);
  });

  it("stays quiet when no bikky MCP processes are running", () => {
    const logs = logger();
    const result = reportRunningBikkyMcpServers({
      detectProcesses: () => ({ processes: [] }),
      logger: logs,
    });

    assert.deepStrictEqual(result, { detected: 0, skippedReason: "not_found" });
    assert.deepStrictEqual(logs.lines, []);
    assert.deepStrictEqual(logs.warnings, []);
  });

  it("warns and skips when process detection fails", () => {
    const logs = logger();

    const result = reportRunningBikkyMcpServers({
      detectProcesses: () => ({ processes: [], error: "ps unavailable" }),
      logger: logs,
    });

    assert.deepStrictEqual(result, { detected: 0, skippedReason: "detect_failed" });
    assert.match(logs.warnings.join("\n"), /ps unavailable/);
  });
});
