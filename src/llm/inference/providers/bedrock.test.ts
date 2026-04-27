import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { bedrockInferenceProvider, _resetBedrockInferenceClient, _setBedrockInferenceClientForTest } from "./bedrock.js";
import { chatCompletion, initLLM, _resetInference } from "../index.js";

describe("bedrock inference provider — metadata", () => {
  let telemetryDir: string;
  let telemetryFile: string;

  beforeEach(() => {
    telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-bedrock-telemetry-"));
    telemetryFile = path.join(telemetryDir, "llm.jsonl");
    process.env.BIKKY_LLM_LOG = telemetryFile;
    _resetInference();
    _resetBedrockInferenceClient();
  });

  afterEach(() => {
    delete process.env.BIKKY_LLM_LOG;
    fs.rmSync(telemetryDir, { recursive: true, force: true });
    _resetInference();
    _resetBedrockInferenceClient();
  });

  it("declares the correct name + label", () => {
    assert.strictEqual(bedrockInferenceProvider.name, "bedrock");
    assert.strictEqual(bedrockInferenceProvider.label, "AWS Bedrock (Converse)");
  });

  it("is NOT browserCompatible", () => {
    assert.strictEqual(bedrockInferenceProvider.browserCompatible, false);
  });

  it("defaults to Claude Sonnet 4 with no baseUrl", () => {
    assert.strictEqual(bedrockInferenceProvider.defaults.model, "us.anthropic.claude-sonnet-4-20250514");
    assert.strictEqual(bedrockInferenceProvider.defaults.baseUrl, undefined);
  });

  it("loads the AWS SDK lazily inside chat() (not at module load)", () => {
    assert.strictEqual(typeof bedrockInferenceProvider.chat, "function");
    assert.strictEqual(typeof _resetBedrockInferenceClient, "function");
  });

  it("exposes Bedrock Converse usage metadata through chatCompletion telemetry", async () => {
    _setBedrockInferenceClientForTest({
      client: {
        async send() {
          return {
            output: { message: { content: [{ text: " ok " }] } },
            usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
            $metadata: { requestId: "bedrock-request-1" },
          };
        },
      },
      ConverseCommand: class {
        constructor(_input: unknown) {}
      },
    });
    initLLM({ config: { provider: "bedrock", model: "test-model" } });

    const out = await chatCompletion({
      promptName: "bedrock-test@1",
      messages: [{ role: "user", content: "x" }],
      telemetry: { subsystem: "unit-test" },
    });

    assert.equal(out, "ok");
    const record = JSON.parse(fs.readFileSync(telemetryFile, "utf-8").trim()) as Record<string, unknown>;
    assert.equal(record.tokens_in_actual, 20);
    assert.equal(record.tokens_out_actual, 5);
    assert.equal(record.tokens_total_actual, 25);
    assert.equal(record.request_id, "bedrock-request-1");
  });
});
