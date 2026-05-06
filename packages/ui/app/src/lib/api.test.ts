import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "./api";
import {
  getDestinationOptions,
  getSelectedDestination,
  setDestinationOptions,
  setSelectedDestination,
  subscribeDestination,
} from "./destinationStore";

describe("destinationStore", () => {
  beforeEach(() => {
    setDestinationOptions([{ name: "solo", collection: "solo", isDefault: true }]);
    setSelectedDestination(null);
  });

  it("keeps single-destination configs implicit", () => {
    setSelectedDestination("solo");
    setDestinationOptions([{ name: "solo", collection: "solo", isDefault: true }]);

    expect(getSelectedDestination()).toBeNull();
    expect(getDestinationOptions()).toEqual([{ name: "solo", collection: "solo", isDefault: true }]);
  });

  it("defaults multi-destination configs to all and repairs stale selections", () => {
    const options = [
      { name: "perso", collection: "perso_collection", isDefault: true },
      { name: "work", collection: "work_collection", isDefault: false },
    ];

    setDestinationOptions(options);
    expect(getSelectedDestination()).toBe("all");

    setSelectedDestination("stale");
    setDestinationOptions(options);
    expect(getSelectedDestination()).toBe("all");
  });

  it("notifies subscribers when the selected destination changes", () => {
    let calls = 0;
    const unsubscribe = subscribeDestination(() => {
      calls += 1;
    });

    setSelectedDestination("work");
    unsubscribe();
    setSelectedDestination("perso");

    expect(calls).toBe(1);
  });
});

describe("apiFetch", () => {
  const requests: string[] = [];

  beforeEach(() => {
    requests.length = 0;
    setDestinationOptions([
      { name: "perso", collection: "perso_collection", isDefault: true },
      { name: "work", collection: "work_collection", isDefault: false },
    ]);
    setSelectedDestination("work");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends the selected destination without clobbering existing query params", async () => {
    await apiFetch("/api/memory/stats?kind=fact");

    expect(requests).toEqual(["/api/memory/stats?kind=fact&destination=work"]);
  });

  it("preserves explicitly supplied destination params", async () => {
    await apiFetch("/api/memory/stats?destination=all");

    expect(requests).toEqual(["/api/memory/stats?destination=all"]);
  });

  it("surfaces structured API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "destination unavailable",
      code: "destination_error",
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(apiFetch("/api/memory/stats")).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "destination unavailable",
      code: "destination_error",
    } satisfies Partial<ApiError>);
  });
});

