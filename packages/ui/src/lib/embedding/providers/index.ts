/**
 * UI embedding providers barrel — importing this file registers all built-in
 * providers via side effect.
 *
 * The UI does NOT include Bedrock because it requires the AWS SDK and an
 * outbound IAM identity — neither of which fit a browser-facing process.
 */

import "./ollama.js";
import "./openai.js";
import "./portkey.js";
