/**
 * Public UI embedding API. Importing this module registers the bundled
 * providers via side effect.
 */

import "./providers/index.js";

import {
  getUIEmbeddingProvider,
  listUIEmbeddingProviders,
  registerUIEmbeddingProvider,
  type ResolvedUIEmbeddingConfig,
  type UIEmbeddingProvider,
} from "./registry.js";

export {
  getUIEmbeddingProvider,
  listUIEmbeddingProviders,
  registerUIEmbeddingProvider,
};
export type { ResolvedUIEmbeddingConfig, UIEmbeddingProvider };
