#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-package-verify-"));

const textExtensions = new Set([
  ".css",
  ".d.ts",
  ".html",
  ".js",
  ".json",
  ".md",
  ".svg",
  ".txt",
]);

const packages = [
  {
    name: "bikky",
    dir: repoRoot,
    bin: "bikky",
    requiredPaths: [
      "bin/bikky.js",
      "dist/cli.js",
      "dist/mcp/index.js",
      "docs/privacy-first.md",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "SUPPORT.md",
      "CHANGELOG.md",
    ],
    smoke: async (binPath, env) => {
      const version = run(binPath, ["--version"], { env });
      assertIncludes(version.stdout, "bikky v", "bikky --version should print a version");

      const status = run(binPath, ["status", "--json", "--no-live", "--no-ui"], {
        env,
        allowedExitCodes: [0, 1],
      });
      parseJson(status.stdout, "bikky status --json should print JSON");

      await assertLongRunning(binPath, ["mcp"], env, "bikky mcp");
    },
  },
  {
    name: "bikky-ui",
    dir: path.join(repoRoot, "packages", "ui"),
    bin: "bikky-ui",
    requiredPaths: [
      "bin/bikky-ui.js",
      "dist/cli.js",
      "dist/public/index.html",
      "README.md",
      "LICENSE",
    ],
    smoke: async (binPath, env) => {
      await assertLongRunning(binPath, [], { ...env, BIKKY_UI_PORT: "0" }, "bikky-ui", "bikky ui running");
    },
  },
];

const forbiddenPathPatterns = [
  { re: /(^|\/)(tasks|node_modules|\.git)(\/|$)/, reason: "task, node_modules, or git metadata" },
  { re: /(^|\/)\.env($|\.)/, reason: "environment files" },
  { re: /(\.test|\.itest)\.(js|d\.ts)$/i, reason: "compiled test artifacts" },
  { re: /(^|\/)(id_rsa|id_ed25519|.*\.pem|.*\.key)$/i, reason: "private key material" },
  { re: /(^|\/)Users\/|\/Users\//i, reason: "absolute local user paths" },
  { re: /saber-zrelli-private|saber-apate|apate/i, reason: "private identity references" },
];

const forbiddenContentPatterns = [
  { re: /gh[pousr]_[A-Za-z0-9_]{20,}/, reason: "GitHub token" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/, reason: "GitHub fine-grained token" },
  { re: /sk-[A-Za-z0-9]{20,}/, reason: "OpenAI-style API key" },
  { re: /AKIA[0-9A-Z]{16}/, reason: "AWS access key id" },
  { re: /AIza[0-9A-Za-z_-]{35}/, reason: "Google API key" },
  { re: /xox[baprs]-[0-9A-Za-z-]{20,}/, reason: "Slack token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "private key block" },
  { re: /\/Users\/saber\b/i, reason: "local user path" },
  { re: /saber-zrelli-private|saber-apate|apate-ai|apate\.com/i, reason: "private identity reference" },
];

try {
  for (const pkg of packages) {
    console.log(`\nVerifying ${pkg.name} package...`);
    const dryRun = pack(pkg, true);
    assertPackageContents(pkg, dryRun.files.map((file) => normalizePackPath(file.path)));

    const packed = pack(pkg, false);
    assertPackageContents(pkg, packed.files.map((file) => normalizePackPath(file.path)));
    scanTarballContents(pkg, packed.tarball);

    const installDir = fs.mkdtempSync(path.join(workDir, `${pkg.name}-install-`));
    npm(["install", "--ignore-scripts", "--no-audit", "--fund=false", "--prefix", installDir, packed.tarball], {
      cwd: repoRoot,
    });

    const binPath = path.join(installDir, "node_modules", ".bin", pkg.bin);
    if (!fs.existsSync(binPath)) {
      throw new Error(`${pkg.name} did not install expected bin at ${binPath}`);
    }

    const home = fs.mkdtempSync(path.join(workDir, `${pkg.name}-home-`));
    await pkg.smoke(binPath, {
      ...process.env,
      BIKKY_HOME: home,
      NO_COLOR: "1",
      CI: "1",
    });
    console.log(`✓ ${pkg.name} package verified`);
  }
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

function pack(pkg, dryRun) {
  const args = ["pack", "--json", "--ignore-scripts"];
  if (dryRun) {
    args.push("--dry-run");
  } else {
    args.push("--pack-destination", workDir);
  }

  const result = npm(args, { cwd: pkg.dir });
  const parsed = parseJson(result.stdout, `npm ${args.join(" ")} output for ${pkg.name}`);
  const entry = parsed[0];
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(`Unexpected npm pack output for ${pkg.name}`);
  }

  return {
    ...entry,
    tarball: dryRun ? null : path.resolve(workDir, entry.filename),
  };
}

function assertPackageContents(pkg, files) {
  const fileSet = new Set(files);
  for (const requiredPath of pkg.requiredPaths) {
    if (!fileSet.has(requiredPath)) {
      throw new Error(`${pkg.name} package is missing required file: ${requiredPath}`);
    }
  }

  for (const file of files) {
    for (const { re, reason } of forbiddenPathPatterns) {
      if (re.test(file)) {
        throw new Error(`${pkg.name} package includes forbidden path (${reason}): ${file}`);
      }
    }
  }
}

function scanTarballContents(pkg, tarball) {
  const extractDir = fs.mkdtempSync(path.join(workDir, `${pkg.name}-extract-`));
  runCommand("tar", ["-xzf", tarball, "-C", extractDir], { cwd: repoRoot });
  const packageDir = path.join(extractDir, "package");

  for (const file of walk(packageDir)) {
    const rel = path.relative(packageDir, file);
    if (!shouldScanText(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    for (const { re, reason } of forbiddenContentPatterns) {
      if (re.test(content)) {
        throw new Error(`${pkg.name} package includes forbidden content (${reason}) in ${rel}`);
      }
    }
  }
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function shouldScanText(file) {
  const stat = fs.statSync(file);
  if (stat.size > 2_000_000) return false;
  const lower = file.toLowerCase();
  if (lower.endsWith(".d.ts")) return true;
  return textExtensions.has(path.extname(lower));
}

function normalizePackPath(file) {
  return file.replace(/^package\//, "");
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) {
    throw new Error(`${message}. Output was: ${value.slice(0, 300)}`);
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${label} was not valid JSON: ${err instanceof Error ? err.message : String(err)}\n${value.slice(0, 500)}`);
  }
}

function npm(args, options) {
  return runCommand("npm", args, options);
}

function run(command, args, { env, allowedExitCodes = [0] } = {}) {
  return runCommand(command, args, {
    cwd: repoRoot,
    env,
    allowedExitCodes,
  });
}

function runCommand(command, args, { cwd, env = process.env, allowedExitCodes = [0] } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (!allowedExitCodes.includes(result.status ?? 1)) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return result;
}

async function assertLongRunning(command, args, env, label, expectedOutput) {
  const minRuntimeMs = expectedOutput ? 0 : 750;
  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited during smoke test with code ${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    if ((!expectedOutput && Date.now() - startedAt >= minRuntimeMs) || (expectedOutput && stdout.includes(expectedOutput))) {
      await stopChild(child);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await stopChild(child);
  throw new Error(`${label} did not become ready during smoke test\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 2_000);
  await waitForClose(child);
  clearTimeout(force);
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("close", resolve);
  });
}
