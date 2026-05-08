import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_BIKKY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bikky-session-destination-"));
process.env.BIKKY_HOME = TEST_BIKKY_HOME;

const {
  applySessionDestinationOverride,
  clearSessionDestinationOverride,
  getSessionDestinationOverrideStatus,
  setSessionDestinationOverride,
} = await import("./session-destination-override.js");
const { getSessionDestinationOverridePath } = await import("./config.js");
const { DestinationNotFoundError } = await import("./routing.js");
import type { Destination } from "./config.js";

const destinations: Destination[] = [
  {
    name: "perso",
    qdrant_url: "https://perso.q.test",
    qdrant_api_key: null,
    collection: "perso_memory",
    match: { entity: ["[Bb]ikky"] },
  },
  {
    name: "work",
    qdrant_url: "https://work.q.test",
    qdrant_api_key: null,
    collection: "work_memory",
    default: true,
  },
];

describe("session destination override", () => {
  before(() => {
    fs.mkdirSync(TEST_BIKKY_HOME, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_BIKKY_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(TEST_BIKKY_HOME, "state"), { recursive: true, force: true });
  });

  it("persists, reads, and clears an override", () => {
    const setStatus = setSessionDestinationOverride("work", destinations, new Date("2026-01-01T00:00:00.000Z"));

    assert.equal(setStatus.active, true);
    assert.equal(setStatus.destination, "work");
    assert.equal(setStatus.set_at, "2026-01-01T00:00:00.000Z");
    assert.equal(fs.existsSync(getSessionDestinationOverridePath()), true);

    const readStatus = getSessionDestinationOverrideStatus(destinations);
    assert.equal(readStatus.active, true);
    assert.equal(readStatus.destination, "work");

    const cleared = clearSessionDestinationOverride();
    assert.equal(cleared.cleared, true);
    assert.equal(getSessionDestinationOverrideStatus(destinations).active, false);
  });

  it("applies the override unless a caller supplied an explicit destination", () => {
    setSessionDestinationOverride("work", destinations);

    assert.deepEqual(
      applySessionDestinationOverride({ content: "Bikky should normally route to perso.", entities: ["bikky"] }, destinations),
      { content: "Bikky should normally route to perso.", entities: ["bikky"], destination: "work" },
    );
    assert.deepEqual(
      applySessionDestinationOverride({ destination: "perso", content: "Bikky", entities: ["bikky"] }, destinations),
      { destination: "perso", content: "Bikky", entities: ["bikky"] },
    );
  });

  it("reports and ignores stale override destinations", () => {
    setSessionDestinationOverride("work", destinations);

    const status = getSessionDestinationOverrideStatus([destinations[0]!]);
    assert.equal(status.exists, true);
    assert.equal(status.active, false);
    assert.equal(status.valid, false);
    assert.equal(status.destination, "work");
    assert.match(status.error ?? "", /unknown destination 'work'/);
    assert.deepEqual(
      applySessionDestinationOverride({ content: "Bikky", entities: ["bikky"] }, [destinations[0]!]),
      { content: "Bikky", entities: ["bikky"] },
    );
  });

  it("rejects unknown destination names when setting", () => {
    assert.throws(
      () => setSessionDestinationOverride("ghost", destinations),
      DestinationNotFoundError,
    );
  });
});
