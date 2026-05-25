import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDestination,
  buildResolver,
  findMatchingIgnoreRule,
  routingInputMatches,
  DestinationNotFoundError,
  NoDestinationsConfiguredError,
} from "./routing.js";
import type { Destination } from "./config.js";

const dst = (name: string, extra: Partial<Destination> = {}): Destination => ({
  name,
  qdrant_url: `https://${name}.example`,
  qdrant_api_key: "k",
  collection: "bikky",
  ...extra,
});

describe("routing.resolveDestination", () => {
  it("throws NoDestinationsConfiguredError when list is empty", () => {
    assert.throws(() => resolveDestination({}, []), NoDestinationsConfiguredError);
  });

  it("respects explicit override by name", () => {
    const a = dst("a");
    const b = dst("b");
    assert.equal(resolveDestination({ destination: "b" }, [a, b]).name, "b");
  });

  it("throws DestinationNotFoundError when override doesn't match", () => {
    const a = dst("a");
    assert.throws(() => resolveDestination({ destination: "ghost" }, [a]), DestinationNotFoundError);
  });

  it("matches by cwd regex", () => {
    const work = dst("work", { match: { cwd: ["/repos/work"] } });
    const personal = dst("personal", { default: true });
    assert.equal(
      resolveDestination({ cwd: "/repos/work/api" }, [work, personal]).name,
      "work",
    );
  });

  it("matches by entity regex", () => {
    const acme = dst("acme", { match: { entity: ["^acme-"] } });
    const fallback = dst("fallback", { default: true });
    assert.equal(
      resolveDestination({ entities: ["acme-billing"] }, [acme, fallback]).name,
      "acme",
    );
  });

  it("matches by content regex", () => {
    const secrets = dst("secrets", { match: { content: ["password|secret"] } });
    const fallback = dst("fallback", { default: true });
    assert.equal(
      resolveDestination({ content: "rotated the secret" }, [secrets, fallback]).name,
      "secrets",
    );
  });

  it("matches by metadata regex", () => {
    const project = dst("project", { match: { metadata: { project: ["^acme$"] } } });
    const fallback = dst("fallback", { default: true });
    assert.equal(
      resolveDestination({ metadata: { project: "acme" } }, [project, fallback]).name,
      "project",
    );
  });

  it("first matching destination wins (array order)", () => {
    const a = dst("a", { match: { entity: ["foo"] } });
    const b = dst("b", { match: { entity: ["foo"] } });
    assert.equal(resolveDestination({ entities: ["foo"] }, [a, b]).name, "a");
  });

  it("falls back to default-flagged destination when no match", () => {
    const a = dst("a", { match: { entity: ["nope"] } });
    const b = dst("b", { default: true });
    const c = dst("c");
    assert.equal(resolveDestination({ entities: ["other"] }, [a, b, c]).name, "b");
  });

  it("falls back to first destination when no default flagged", () => {
    const a = dst("a", { match: { entity: ["nope"] } });
    const b = dst("b");
    assert.equal(resolveDestination({ entities: ["other"] }, [a, b]).name, "a");
  });

  it("override beats matching", () => {
    const a = dst("a", { match: { entity: ["foo"] } });
    const b = dst("b");
    assert.equal(
      resolveDestination({ destination: "b", entities: ["foo"] }, [a, b]).name,
      "b",
    );
  });
});

describe("routing.buildResolver", () => {
  it("returns a closure that resolves consistently", () => {
    const a = dst("a", { match: { entity: ["foo"] } });
    const b = dst("b", { default: true });
    const resolve = buildResolver([a, b]);
    assert.equal(resolve({ entities: ["foo"] }).name, "a");
    assert.equal(resolve({ entities: ["bar"] }).name, "b");
  });

  it("closure throws on empty destinations", () => {
    const resolve = buildResolver([]);
    assert.throws(() => resolve({}), NoDestinationsConfiguredError);
  });
});

describe("routing ignore rules", () => {
  it("uses destination match semantics for ignore rules", () => {
    assert.equal(
      routingInputMatches(
        {
          cwd: ["/private"],
          entity: ["^secret-"],
          content: ["password"],
          metadata: { repo: ["^private/"] },
        },
        {
          cwd: "/work",
          entities: ["project"],
          content: "safe note",
          metadata: { repo: "private/notes" },
        },
      ),
      true,
    );
  });

  it("returns the first matching ignore rule in array order", () => {
    const match = findMatchingIgnoreRule(
      { content: "resume update", entities: ["resume"] },
      [
        { name: "first", match: { content: ["resume"] } },
        { name: "second", match: { entity: ["resume"] } },
      ],
    );

    assert.equal(match?.name, "first");
    assert.equal(match?.index, 0);
  });

  it("does not let destination overrides affect ignore matching", () => {
    const match = findMatchingIgnoreRule(
      { destination: "work", content: "garden notes" },
      [{ name: "private-topics", match: { content: ["garden"] } }],
    );

    assert.equal(match?.name, "private-topics");
  });
});
