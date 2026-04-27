import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addRedactionPayload,
  combineRedactions,
  redactStorageText,
} from "./redaction.js";

describe("privacy/redaction", () => {
  it("redacts assignment-style secrets", () => {
    const result = redactStorageText("Configured service with password=supersecretvalue and api_key: sk-testsecretvalue123456789.");

    assert.equal(result.text, "Configured service with password=[REDACTED:secret] and api_key: [REDACTED:secret]");
    assert.equal(result.redacted, true);
    assert.equal(result.summary, "secret:2");
    assert.deepEqual(result.matches, [{ type: "secret", count: 2 }]);
  });

  it("redacts bearer and common token prefixes", () => {
    const result = redactStorageText("Use Bearer abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz1234567890");

    assert.equal(result.text, "Use Bearer [REDACTED:secret] and [REDACTED:secret]");
    assert.deepEqual(result.matches, [{ type: "secret", count: 2 }]);
  });

  it("leaves non-secret text unchanged", () => {
    const result = redactStorageText("Bikky stores memory in Qdrant.");

    assert.equal(result.text, "Bikky stores memory in Qdrant.");
    assert.equal(result.redacted, false);
    assert.equal(result.summary, "none");
    assert.deepEqual(result.matches, []);
  });

  it("can be explicitly disabled", () => {
    const result = redactStorageText("password=supersecretvalue", { enabled: false });

    assert.equal(result.text, "password=supersecretvalue");
    assert.equal(result.redacted, false);
  });

  it("combines redaction summaries", () => {
    const first = redactStorageText("password=one");
    const second = redactStorageText("token=two");

    assert.deepEqual(combineRedactions([first, second]), {
      redacted: true,
      summary: "secret:2",
      matches: [{ type: "secret", count: 2 }],
    });
  });

  it("adds payload metadata only when redacted", () => {
    const payload: Record<string, unknown> = {};
    addRedactionPayload(payload, redactStorageText("password=one"));

    assert.deepEqual(payload.redaction, {
      redacted: true,
      summary: "secret:1",
      matches: [{ type: "secret", count: 1 }],
    });

    const cleanPayload: Record<string, unknown> = {};
    addRedactionPayload(cleanPayload, redactStorageText("no secrets here"));
    assert.equal(cleanPayload.redaction, undefined);
  });
});
