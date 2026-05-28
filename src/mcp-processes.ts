import { spawnSync } from "node:child_process";
export interface BikkyMcpProcess {
  pid: number;
  command: string;
}

export interface McpProcessDetectionResult {
  processes: BikkyMcpProcess[];
  error?: string;
}

export interface ReportRunningBikkyMcpServersResult {
  detected: number;
  skippedReason?: "not_found" | "detect_failed";
}

export interface ReportRunningBikkyMcpServersOptions {
  detectProcesses?: () => McpProcessDetectionResult;
  currentPid?: number;
  logger?: Pick<Console, "log" | "warn">;
}

const truncateCommand = (command: string): string => {
  const maxLength = 160;
  return command.length > maxLength ? `${command.slice(0, maxLength - 1)}...` : command;
};

const unquote = (token: string): string => {
  if (token.length < 2) return token;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return token.slice(1, -1);
  }
  return token;
};

export const splitCommandLine = (command: string): string[] => {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token) tokens.push(unquote(token));
  }
  return tokens;
};

const normalizedToken = (token: string): string => token.replace(/\\/g, "/").toLowerCase();

const baseName = (token: string): string => {
  const normalized = normalizedToken(token);
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.endsWith(".cmd") ? base.slice(0, -4) : base;
};

const isBikkyPackageToken = (token: string): boolean => {
  const base = baseName(token);
  return base === "bikky" || base === "bikky.js" || /^bikky@[\w.-]+$/.test(base);
};

const isBikkyCliPath = (token: string): boolean => {
  const normalized = normalizedToken(token);
  if (!normalized.includes("/bikky/") && !normalized.includes("/node_modules/bikky/")) return false;
  return normalized.endsWith("/bin/bikky.js") || normalized.endsWith("/dist/cli.js");
};

export const isBikkyMcpCommand = (command: string): boolean => {
  const tokens = splitCommandLine(command);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if ((isBikkyPackageToken(token) || isBikkyCliPath(token)) && tokens[index + 1] === "mcp") {
      return true;
    }
  }
  return false;
};

export const parsePsOutput = (output: string, currentPid = process.pid): BikkyMcpProcess[] => {
  const processes: BikkyMcpProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (!Number.isFinite(pid) || pid === currentPid) continue;
    const command = match[2];
    if (command && isBikkyMcpCommand(command)) {
      processes.push({ pid, command });
    }
  }
  return processes;
};

export const detectRunningBikkyMcpServers = (currentPid = process.pid): McpProcessDetectionResult => {
  const result = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return { processes: [], error: result.error.message };
  }

  if (result.status !== 0) {
    const detail = typeof result.stderr === "string" && result.stderr.trim()
      ? result.stderr.trim()
      : `ps exited with status ${result.status ?? "unknown"}`;
    return { processes: [], error: detail };
  }

  return { processes: parsePsOutput(result.stdout, currentPid) };
};

const MCP_RELOAD_GUIDANCE = [
  "To use updated bikky MCP code: GitHub Copilot CLI users should run /restart in the Copilot CLI session.",
  "Claude Code users should restart Claude Code, then run claude --continue or claude -c to resume.",
  "Other stdio MCP clients should use their MCP reload/restart action if available; otherwise restart the client session.",
].join(" ");

export const reportRunningBikkyMcpServers = (
  options: ReportRunningBikkyMcpServersOptions = {},
): ReportRunningBikkyMcpServersResult => {
  const logger = options.logger ?? console;
  const detection = options.detectProcesses
    ? options.detectProcesses()
    : detectRunningBikkyMcpServers(options.currentPid);

  if (detection.error) {
    logger.warn(`⚠️  Could not detect running bikky MCP servers: ${detection.error}`);
    return { detected: 0, skippedReason: "detect_failed" };
  }

  const processes = detection.processes;
  if (processes.length === 0) {
    return { detected: 0, skippedReason: "not_found" };
  }

  logger.log(`\n🔁 Found ${processes.length} running bikky MCP server process${processes.length === 1 ? "" : "es"}:`);
  for (const proc of processes) {
    logger.log(`   PID ${proc.pid}: ${truncateCommand(proc.command)}`);
  }

  logger.warn(`⚠️  bikky setup does not terminate client-owned MCP server processes. ${MCP_RELOAD_GUIDANCE}`);
  return { detected: processes.length };
};
