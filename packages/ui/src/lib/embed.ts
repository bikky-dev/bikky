/**
 * Lightweight embedding client for @bikky/ui.
 *
 * Dispatches via the UI provider registry (./embedding/registry). Adding a new
 * provider is a single file under ./embedding/providers/ — no edits here.
 */

import { loadConfig } from "./config.js";
import { getUIEmbeddingProvider } from "./embedding/index.js";
import type { ResolvedUIEmbeddingConfig } from "./embedding/index.js";

function resolveCfg(): { provider: ReturnType<typeof getUIEmbeddingProvider>; cfg: ResolvedUIEmbeddingConfig } {
  const cfg = loadConfig();
  const provider = getUIEmbeddingProvider(cfg.embedding.provider);
  return {
    provider,
    cfg: {
      provider: cfg.embedding.provider,
      model: cfg.embedding.model,
      baseUrl: cfg.embedding.base_url.replace(/\/+$/, ""),
      apiKey: cfg.embedding.api_key,
      extra: cfg.embedding.extra ?? {},
    },
  };
}

export function isEmbeddingAvailable(): boolean {
  const { provider } = resolveCfg();
  return Boolean(provider?.browserCompatible);
}

export async function embed(text: string): Promise<number[]> {
  const { provider, cfg } = resolveCfg();
  if (!provider) {
    throw new Error(
      `Embedding provider "${cfg.provider}" is not available in the UI. ` +
      `Configure one of the registered UI providers (e.g. ollama, openai, portkey).`,
    );
  }
  if (!provider.browserCompatible) {
    throw new Error(
      `Embedding provider "${provider.name}" is not browser-compatible. ` +
      `Configure ollama, openai, or portkey for the UI.`,
    );
  }
  return provider.embed(text, cfg);
}

