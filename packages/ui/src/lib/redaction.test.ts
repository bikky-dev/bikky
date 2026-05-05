import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addRedactionPayload,
  combineRedactions,
  redactStorageText,
} from "./redaction.js";

describe("ui/lib/redaction", () => {
  it("redacts common secret forms while preserving safe prefixes", () => {
    const result = redactStorageText(
      "password=hunter2 token: abcdefghijklmnop Bearer eyJhbGciOiJsecret sk-abcdefghijklmnopqrstuvwxyz",
    );

    assert.equal(result.redacted, true);
    assert.equal(result.summary, "secret:4");
    assert.equal(result.text, "password=[REDACTED:secret] token: [REDACTED:secret] Bearer [REDACTED:secret] [REDACTED:secret]");
    assert.deepEqual(result.matches, [{ type: "secret", count: 4 }]);
  });

  it("combines redaction summaries and ignores clean entries", () => {
    const combined = combineRedactions([
      redactStorageText("api_key=supersecretvalue"),
      redactStorageText("no secrets here"),
      redactStorageText("Authorization Bearer abcdefghijklmnop"),
      null,
      undefined,
    ]);

    assert.deepEqual(combined, {
      redacted: true,
      summary: "secret:2",
      matches: [{ type: "secret", count: 2 }],
    });
  });

  it("only attaches a redaction payload when something was redacted", () => {
    const cleanPayload: Record<string, unknown> = {};
    addRedactionPayload(cleanPayload, redactStorageText("safe text"));
    assert.deepEqual(cleanPayload, {});

    const redactedPayload: Record<string, unknown> = {};
    addRedactionPayload(redactedPayload, redactStorageText("client_secret=verysecretvalue"));
    assert.deepEqual(redactedPayload, {
      redaction: {
        redacted: true,
        summary: "secret:1",
        matches: [{ type: "secret", count: 1 }],
      },
    });
  });
});
