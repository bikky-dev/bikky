/**
 * Inference providers barrel — importing this file registers all built-in
 * providers via side effect. To add a new provider, drop a file alongside and
 * add a single import line below.
 */

import "./ollama.js";
import "./openai.js";
import "./bedrock.js";
import "./portkey.js";
