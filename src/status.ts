/**
 * Read-only health diagnostics for `bikky status`.
 */

import {
  getActiveConfigEnvOverrides,
  inspectConfigFile,
  loadConfig,
  type BikkyConfig,
  type ConfigIssue,
} from "./config.js";
import { getDaemonStatus } from "./lifecycle.js";
import {
  embed,
  getEmbeddingConfig,
  getEmbeddingProvider,
  getInferenceProvider,
  initEmbedding,
  initLLM,
  listEmbeddingProviders,
  listInferenceProviders,
} from "./llm/index.js";
import {
  getCollectionVectorSize,
  inspectPayloadIndexes,
  QdrantClient,
  QdrantNotFoundError,
  type QdrantIndexMismatch,
  type QdrantIndexSpec,
} from "./lib/qdrant-client.js";
import { QDRANT_INDEXES } from "./mcp/taxonomy.js";
import {
  MAINTENANCE_STATE_PATH,
  readMaintenanceState,
  type MaintenanceJobName,
  type MaintenanceRunSummary,
} from "./daemon/maintenance-state.js";

export type DiagnosticState = "ok" | "warn" | "error" | "skipped";

export interface DiagnosticIssue {
  severity: "error" | "warning";
  message: string;
  path?: string;
}

export interface ConfigStatus {
  status: DiagnosticState;
  path: string;
  exists: boolean;
  parse_error: string | null;
  env_overrides: string[];
  issues: DiagnosticIssue[];
}

export interface QdrantStatus {
  status: DiagnosticState;
  configured: boolean;
  reachable: boolean;
  url: string | null;
  collection: string;
  collection_exists: boolean;
  points_count: number | null;
  vectors_count: number | null;
  vector_size: number | null;
  expected_vector_size: number | null;
  expected_indexes: number;
  present_indexes: number;
  missing_indexes: QdrantIndexSpec[];
  mismatched_indexes: QdrantIndexMismatch[];
  error: string | null;
}

export interface ProviderStatus {
  status: DiagnosticState;
  provider: string;
  model: string;
  base_url: string;
  dimensions?: number;
  live_checked: boolean;
  error: string | null;
}

export interface DaemonStatusReport {
  status: DiagnosticState;
  running: boolean;
  pid: number | null;
}

export interface MaintenanceJobStatus {
  last_run_at: string | null;
  cursor_updated_at: string | null;
  last_summary: MaintenanceRunSummary | null;
}

export interface MaintenanceStatusReport {
  status: DiagnosticState;
  state_path: string;
  relation_inference: MaintenanceJobStatus;
  entity_typing: MaintenanceJobStatus;
}

export interface UiStatusReport {
  status: DiagnosticState;
  checked: boolean;
  url: string;
  ok: boolean | null;
  error: string | null;
}

export interface BikkyStatusReport {
  ok: boolean;
  config: ConfigStatus;
  qdrant: QdrantStatus;
  embedding: ProviderStatus;
  llm: ProviderStatus;
  daemon: DaemonStatusReport;
  maintenance: MaintenanceStatusReport;
  ui: UiStatusReport;
  mcp: { status: DiagnosticState; message: string };
}

export interface CollectStatusOptions {
  live?: boolean;
  checkUi?: boolean;
  uiUrl?: string;
  uiTimeoutMs?: number;
  qdrantTimeoutMs?: number;
}

const API_KEY_REQUIRED_PROVIDERS = new Set(["openai", "portkey"]);
const SENSITIVE_QUERY_PARAM = /(api[-_]?key|access[-_]?token|token|secret|password|credential|auth)/i;

function diagnosticIssue(issue: ConfigIssue): DiagnosticIssue {
  return {
    severity: issue.severity === "error" ? "error" : "warning",
    path: issue.path,
    message: issue.message,
  };
}

function statusFromIssues(issues: DiagnosticIssue[]): DiagnosticState {
  if (issues.some((issue) => issue.severity === "error")) return "error";
  if (issues.length > 0) return "warn";
  return "ok";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function apiKeyIssue(provider: string, apiKey: string | null): string | null {
  if (!API_KEY_REQUIRED_PROVIDERS.has(provider)) return null;
  return apiKey ? null : `${provider} provider requires an API key`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sanitizeStatusUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAM.test(key)) parsed.searchParams.set(key, "REDACTED");
    }
    return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "" : "/");
  } catch {
    return url
      .replace(/\/\/[^/@\s]+@/, "//[REDACTED]@")
      .replace(/([?&][^=&#]*(?:api[-_]?key|access[-_]?token|token|secret|password|credential|auth)[^=&#]*=)[^&#]*/gi, "$1REDACTED");
  }
}

function collectConfigStatus(): ConfigStatus {
  const file = inspectConfigFile();
  const issues = file.issues.map(diagnosticIssue);
  return {
    status: statusFromIssues(issues),
    path: file.path,
    exists: file.exists,
    parse_error: file.parse_error,
    env_overrides: getActiveConfigEnvOverrides(),
    issues,
  };
}

async function collectQdrantStatus(cfg: BikkyConfig, embeddingDimensions: number | null, opts: CollectStatusOptions): Promise<QdrantStatus> {
  const qdrantUrl = typeof cfg.qdrant_url === "string" ? cfg.qdrant_url : null;
  const collection = typeof cfg.collection === "string" && cfg.collection ? cfg.collection : "bikky";
  const base: QdrantStatus = {
    status: "error",
    configured: Boolean(qdrantUrl),
    reachable: false,
    url: sanitizeStatusUrl(qdrantUrl),
    collection,
    collection_exists: false,
    points_count: null,
    vectors_count: null,
    vector_size: null,
    expected_vector_size: embeddingDimensions,
    expected_indexes: QDRANT_INDEXES.length,
    present_indexes: 0,
    missing_indexes: [],
    mismatched_indexes: [],
    error: null,
  };

  if (!qdrantUrl) {
    return { ...base, error: "Qdrant URL is not configured" };
  }

  const client = new QdrantClient({
    url: qdrantUrl,
    apiKey: typeof cfg.qdrant_api_key === "string" ? cfg.qdrant_api_key : null,
    collection,
    timeoutMs: opts.qdrantTimeoutMs ?? Math.min(numberOrNull(cfg.qdrant_client.timeout_ms) ?? 5_000, 5_000),
    retries: 0,
  });

  try {
    await client.request("GET", "/collections");
    base.reachable = true;
  } catch (err) {
    return { ...base, error: errMessage(err) };
  }

  try {
    const info = await client.getCollectionInfo();
    const readiness = inspectPayloadIndexes(info, QDRANT_INDEXES);
    const vectorSize = getCollectionVectorSize(info);
    const vectorMismatch =
      vectorSize !== null && embeddingDimensions !== null && vectorSize !== embeddingDimensions;
    base.collection_exists = true;
    base.points_count = typeof info.points_count === "number" ? info.points_count : null;
    base.vectors_count = typeof info.vectors_count === "number" ? info.vectors_count : null;
    base.vector_size = vectorSize;
    base.present_indexes = Object.keys(readiness.present).length;
    base.missing_indexes = readiness.missing;
    base.mismatched_indexes = readiness.mismatched;
    base.status = vectorMismatch || readiness.mismatched.length > 0
      ? "error"
      : readiness.missing.length > 0
        ? "warn"
        : "ok";
    base.error = vectorMismatch
      ? `Qdrant vector size ${vectorSize} does not match embedding dimensions ${embeddingDimensions}`
      : readiness.mismatched.length > 0
        ? "Qdrant payload indexes have schema mismatches"
        : null;
    return base;
  } catch (err) {
    if (err instanceof QdrantNotFoundError) {
      return { ...base, reachable: true, collection_exists: false, error: `Collection '${collection}' does not exist` };
    }
    return { ...base, reachable: true, error: errMessage(err) };
  }
}

async function collectEmbeddingStatus(cfg: BikkyConfig, live: boolean): Promise<ProviderStatus> {
  const dimensions = numberOrNull(cfg.embedding.dimensions) ?? undefined;
  const base: ProviderStatus = {
    status: "error",
    provider: cfg.embedding.provider,
    model: cfg.embedding.model,
    base_url: sanitizeStatusUrl(cfg.embedding.base_url) ?? "",
    dimensions,
    live_checked: false,
    error: null,
  };

  try {
    getEmbeddingProvider(cfg.embedding.provider);
    const keyIssue = apiKeyIssue(cfg.embedding.provider, cfg.embedding.api_key);
    if (keyIssue) return { ...base, error: keyIssue };

    const resolved = initEmbedding({
      provider: cfg.embedding.provider,
      model: cfg.embedding.model,
      dimensions,
      baseUrl: cfg.embedding.base_url,
      apiKey: cfg.embedding.api_key,
      extra: cfg.embedding.extra ?? {},
      timeoutMs: cfg.embedding.timeout_ms,
      retries: cfg.embedding.retries,
      retryBaseDelayMs: cfg.embedding.retry_base_delay_ms,
    });
    base.provider = resolved.provider;
    base.model = resolved.model;
    base.base_url = sanitizeStatusUrl(resolved.baseUrl) ?? "";
    base.dimensions = resolved.dimensions;

    if (live) {
      await embed("bikky status embedding check");
      base.live_checked = true;
    }

    return { ...base, status: "ok" };
  } catch (err) {
    const known = listEmbeddingProviders().map((p) => p.name).sort().join(", ");
    return { ...base, error: `${errMessage(err)} (available embedding providers: ${known})` };
  }
}

function collectLlmStatus(cfg: BikkyConfig): ProviderStatus {
  const base: ProviderStatus = {
    status: "error",
    provider: cfg.llm.provider,
    model: cfg.llm.model,
    base_url: sanitizeStatusUrl(cfg.llm.base_url) ?? "",
    live_checked: false,
    error: null,
  };

  try {
    getInferenceProvider(cfg.llm.provider);
    if (cfg.llm.fallback_provider) getInferenceProvider(cfg.llm.fallback_provider);
    const keyIssue = apiKeyIssue(cfg.llm.provider, cfg.llm.api_key);
    if (keyIssue) return { ...base, error: keyIssue };

    const resolved = initLLM({
      config: {
        provider: cfg.llm.provider,
        model: cfg.llm.model,
        baseUrl: cfg.llm.base_url,
        apiKey: cfg.llm.api_key,
        fallback: cfg.llm.fallback_provider ?? null,
        extra: cfg.llm.extra ?? {},
        timeoutMs: cfg.llm.timeout_ms,
        retries: cfg.llm.retries,
        retryBaseDelayMs: cfg.llm.retry_base_delay_ms,
      },
    });
    return {
      ...base,
      status: "ok",
      provider: resolved.provider,
      model: resolved.model,
      base_url: sanitizeStatusUrl(resolved.baseUrl) ?? "",
    };
  } catch (err) {
    const known = listInferenceProviders().map((p) => p.name).sort().join(", ");
    return { ...base, error: `${errMessage(err)} (available LLM providers: ${known})` };
  }
}

function collectDaemonStatus(): DaemonStatusReport {
  const daemon = getDaemonStatus();
  return {
    status: daemon.running ? "ok" : "warn",
    running: daemon.running,
    pid: daemon.pid,
  };
}

function collectMaintenanceStatus(): MaintenanceStatusReport {
  const state = readMaintenanceState();
  const jobStatus = (jobName: MaintenanceJobName): MaintenanceJobStatus => {
    const job = state.jobs[jobName];
    return {
      last_run_at: job.last_run_at,
      cursor_updated_at: job.cursor_updated_at,
      last_summary: job.last_summary,
    };
  };
  const summaries = [state.jobs.relation_inference.last_summary, state.jobs.entity_typing.last_summary];
  const hasError = summaries.some((summary) => summary?.status === "error");
  return {
    status: hasError ? "warn" : "ok",
    state_path: MAINTENANCE_STATE_PATH,
    relation_inference: jobStatus("relation_inference"),
    entity_typing: jobStatus("entity_typing"),
  };
}

async function collectUiStatus(opts: CollectStatusOptions): Promise<UiStatusReport> {
  const url = opts.uiUrl ?? "http://localhost:1422/health";
  const reportedUrl = sanitizeStatusUrl(url) ?? url;
  if (opts.checkUi === false) {
    return { status: "skipped", checked: false, url: reportedUrl, ok: null, error: null };
  }

  try {
    const signal = AbortSignal.timeout(opts.uiTimeoutMs ?? 750);
    const resp = await fetch(url, { signal });
    if (!resp.ok) {
      return { status: "warn", checked: true, url: reportedUrl, ok: false, error: `HTTP ${resp.status}` };
    }
    const body = await resp.json().catch(() => null) as { ok?: unknown } | null;
    const ok = body?.ok === true;
    return { status: ok ? "ok" : "warn", checked: true, url: reportedUrl, ok, error: ok ? null : "health response did not include ok=true" };
  } catch (err) {
    return { status: "skipped", checked: true, url: reportedUrl, ok: null, error: errMessage(err) };
  }
}

export async function collectStatus(opts: CollectStatusOptions = {}): Promise<BikkyStatusReport> {
  const live = opts.live !== false;
  const config = collectConfigStatus();
  const cfg = loadConfig();
  const embedding = await collectEmbeddingStatus(cfg, live);
  const qdrant = await collectQdrantStatus(
    cfg,
    embedding.dimensions ?? getEmbeddingConfigSafe(),
    opts,
  );
  const llm = collectLlmStatus(cfg);
  const daemon = collectDaemonStatus();
  const maintenance = collectMaintenanceStatus();
  const ui = await collectUiStatus(opts);
  const required = [config.status, qdrant.status, embedding.status, llm.status];

  return {
    ok: required.every((status) => status !== "error"),
    config,
    qdrant,
    embedding,
    llm,
    daemon,
    maintenance,
    ui,
    mcp: { status: "ok", message: "managed by your editor (stdio)" },
  };
}

function getEmbeddingConfigSafe(): number | null {
  try {
    return getEmbeddingConfig().dimensions;
  } catch {
    return null;
  }
}

function icon(status: DiagnosticState): string {
  switch (status) {
    case "ok": return "🟢";
    case "warn": return "🟡";
    case "error": return "🔴";
    case "skipped": return "⚪";
  }
}

function qdrantSummary(qdrant: QdrantStatus): string {
  if (!qdrant.configured) return "not configured";
  if (!qdrant.reachable) return `unreachable (${qdrant.error ?? "unknown error"})`;
  if (!qdrant.collection_exists) return qdrant.error ?? "collection missing";
  const matchingIndexes = qdrant.expected_indexes - qdrant.missing_indexes.length - qdrant.mismatched_indexes.length;
  const indexSummary = `${matchingIndexes}/${qdrant.expected_indexes} expected indexes`;
  const details = [
    `collection '${qdrant.collection}'`,
    indexSummary,
    qdrant.vector_size !== null ? `vector size ${qdrant.vector_size}` : null,
  ].filter(Boolean).join(", ");
  return qdrant.error ? `${details} — ${qdrant.error}` : details;
}

function maintenanceJobSummary(label: string, job: MaintenanceJobStatus): string {
  const summary = job.last_summary;
  if (!summary) return `${label}: never run`;
  const parts = [
    `${label}: ${summary.status}`,
    `last ${summary.ran_at}`,
    `candidates ${summary.candidates_seen}`,
    `LLM ${summary.llm_calls}`,
    `accepted ${summary.accepted}`,
  ];
  if (summary.deterministic !== undefined) parts.push(`deterministic ${summary.deterministic}`);
  if (summary.skipped_reason) parts.push(`reason ${summary.skipped_reason}`);
  if (summary.error) parts.push(`error ${summary.error}`);
  return parts.join(", ");
}

export function formatStatusReport(report: BikkyStatusReport): string {
  const lines: string[] = [];
  const configLabel = report.config.exists ? report.config.path : `${report.config.path} (not created yet)`;

  lines.push(`Config:   ${icon(report.config.status)} ${report.config.status} — ${configLabel}`);
  if (report.config.env_overrides.length > 0) {
    lines.push(`          env overrides: ${report.config.env_overrides.join(", ")}`);
  }
  for (const issue of report.config.issues) {
    lines.push(`          ${issue.severity}: ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
  }

  lines.push(`Qdrant:   ${icon(report.qdrant.status)} ${report.qdrant.status} — ${qdrantSummary(report.qdrant)}`);
  if (report.qdrant.missing_indexes.length > 0) {
    lines.push(`          missing indexes: ${report.qdrant.missing_indexes.map((idx) => idx.field_name).join(", ")}`);
  }
  if (report.qdrant.mismatched_indexes.length > 0) {
    const mismatches = report.qdrant.mismatched_indexes
      .map((idx) => `${idx.field_name} expected ${idx.expected_schema}, got ${idx.actual_schema ?? "missing"}`)
      .join("; ");
    lines.push(`          index mismatches: ${mismatches}`);
  }

  const embLive = report.embedding.live_checked ? "live check passed" : "configured";
  lines.push(
    `Embedding:${icon(report.embedding.status).padStart(4, " ")} ${report.embedding.status} — ` +
    `${report.embedding.provider}/${report.embedding.model} (${report.embedding.dimensions ?? "?"}d), ${embLive}` +
    `${report.embedding.error ? ` — ${report.embedding.error}` : ""}`,
  );

  lines.push(
    `LLM:      ${icon(report.llm.status)} ${report.llm.status} — ` +
    `${report.llm.provider}/${report.llm.model}, provider config checked (no live chat)` +
    `${report.llm.error ? ` — ${report.llm.error}` : ""}`,
  );

  lines.push(`Daemon:   ${icon(report.daemon.status)} ${report.daemon.running ? `running (PID ${report.daemon.pid})` : "stopped"}`);
  lines.push(`Maint:    ${icon(report.maintenance.status)} ${maintenanceJobSummary("relations", report.maintenance.relation_inference)}`);
  lines.push(`          ${maintenanceJobSummary("entity typing", report.maintenance.entity_typing)}`);
  lines.push(`UI:       ${icon(report.ui.status)} ${report.ui.checked ? report.ui.url : "not checked"}${report.ui.error ? ` — ${report.ui.error}` : ""}`);
  lines.push(`MCP:      ${icon(report.mcp.status)} ${report.mcp.message}`);

  return lines.join("\n");
}

export function statusExitCode(report: BikkyStatusReport): number {
  return report.ok ? 0 : 1;
}
