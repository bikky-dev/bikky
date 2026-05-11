import { expect, test, type Page } from "@playwright/test";

interface CapturedRequest {
  path: string;
  url: URL;
}

const categoryCounts = {
  engineering: 4,
  product: 3,
  human: 2,
};

const subtypeCounts = {
  product_decision: 2,
  product_requirement: 1,
};

test("Memory filters are forwarded to browse and search API requests", async ({ page }) => {
  const captured: CapturedRequest[] = [];
  await mockMemoryApi(page, captured);

  await page.goto("/memory?sort=newest");

  await expectRequest(captured, "/api/memory/browse", {
    sort: "newest",
    destination: "all",
  });

  await page.getByRole("button", { name: "Add category Product" }).click();
  await expectRequest(captured, "/api/memory/browse", {
    category: "product",
    sort: "newest",
    destination: "all",
  });

  await page.getByRole("button", { name: "Add subtype Product decision" }).click();
  await expectRequest(captured, "/api/memory/browse", {
    category: "product",
    memory_subtype: "product_decision",
    sort: "newest",
    destination: "all",
  });

  await page.getByRole("textbox", { name: "Entity filter" }).fill("bikky-ui");
  await expectRequest(captured, "/api/memory/browse", {
    category: "product",
    memory_subtype: "product_decision",
    entity: "bikky-ui",
    sort: "newest",
    destination: "all",
  });

  await page.getByRole("combobox", { name: "Usefulness filter" }).selectOption("positive");
  await expectRequest(captured, "/api/memory/browse", {
    category: "product",
    memory_subtype: "product_decision",
    entity: "bikky-ui",
    usefulness: "positive",
    sort: "newest",
    destination: "all",
  });

  await page.getByRole("combobox", { name: "Sort memories" }).selectOption("oldest");
  await expectRequest(captured, "/api/memory/browse", {
    category: "product",
    memory_subtype: "product_decision",
    entity: "bikky-ui",
    usefulness: "positive",
    sort: "oldest",
    destination: "all",
  });

  const presetSince = presetSinceDate(6);
  await page.getByRole("button", { name: "Past 7 days" }).click();
  await expectRequest(captured, "/api/memory/browse", {
    category: "product",
    memory_subtype: "product_decision",
    entity: "bikky-ui",
    usefulness: "positive",
    sort: "oldest",
    since: new Date(presetSince).toISOString(),
    until: null,
    destination: "all",
  });

  const expectedSince = new Date("2026-01-02").toISOString();
  const expectedUntil = new Date("2026-01-09T23:59:59").toISOString();
  await page.getByLabel("From date").fill("2026-01-02");
  await page.getByLabel("Until date").fill("2026-01-09");
  await expectRequest(captured, "/api/memory/browse", {
    category: "product",
    memory_subtype: "product_decision",
    entity: "bikky-ui",
    usefulness: "positive",
    sort: "oldest",
    since: expectedSince,
    until: expectedUntil,
    destination: "all",
  });

  await page.getByRole("combobox", { name: "Destination" }).selectOption("bikky");
  await expectRequest(captured, "/api/memory/browse", {
    category: "product",
    memory_subtype: "product_decision",
    entity: "bikky-ui",
    usefulness: "positive",
    sort: "oldest",
    since: expectedSince,
    until: expectedUntil,
    destination: "bikky",
  });

  await page.getByRole("textbox", { name: "Search memory" }).fill("filter audit");
  await page.getByRole("button", { name: "Search" }).click();
  await expectRequest(captured, "/api/memory/search", {
    q: "filter audit",
    category: "product",
    memory_subtype: "product_decision",
    entity: "bikky-ui",
    usefulness: "positive",
    sort: "oldest",
    since: expectedSince,
    until: expectedUntil,
    limit: "20",
    destination: "bikky",
  });

  await page.getByRole("button", { name: "Clear all" }).click();
  await expectRequest(captured, "/api/memory/search", {
    q: "filter audit",
    category: null,
    memory_subtype: null,
    entity: null,
    usefulness: null,
    since: null,
    until: null,
    sort: "oldest",
    destination: "bikky",
  });
});

async function mockMemoryApi(page: Page, captured: CapturedRequest[]) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    captured.push({ path: url.pathname, url });

    if (url.pathname === "/api/destinations") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          destinations: [
            { name: "bikky", collection: "bikky", isDefault: true },
            { name: "work", collection: "work", isDefault: false },
          ],
        }),
      });
      return;
    }

    if (url.pathname === "/api/memory/stats") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total: 9,
          active: 9,
          superseded: 0,
          byCategory: categoryCounts,
          byKind: { fact: 9 },
          bySubtype: subtypeCounts,
        }),
      });
      return;
    }

    if (url.pathname === "/api/memory/search") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [memoryFact("search-result", url)],
          count: 1,
        }),
      });
      return;
    }

    if (url.pathname === "/api/memory/browse") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          results: [memoryFact("browse-result", url)],
          count: 1,
          nextOffset: null,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: `Unhandled ${url.pathname}` }),
    });
  });
}

function memoryFact(id: string, requestUrl: URL) {
  return {
    id,
    content: `Mock memory for ${requestUrl.pathname}`,
    category: requestUrl.searchParams.get("category")?.split(",")[0] || "engineering",
    domain: "software_engineering",
    kind: "fact",
    memory_subtype: requestUrl.searchParams.get("memory_subtype"),
    entities: requestUrl.searchParams.get("entity") ? [requestUrl.searchParams.get("entity")] : ["bikky-ui"],
    confidence: 0.91,
    created_at: "2026-01-10T00:00:00.000Z",
    updated_at: "2026-01-10T00:00:00.000Z",
    usefulness_percent: requestUrl.searchParams.get("usefulness") === "positive" ? 100 : null,
    user_name: "Saber",
    origin: {
      user: { name: "Saber" },
      interface: "ui",
      operation: { action: "test", subsystem: "memory" },
    },
  };
}

async function expectRequest(
  captured: CapturedRequest[],
  path: string,
  expectedParams: Record<string, string | null>,
) {
  await expect
    .poll(() => {
      const match = [...captured]
        .reverse()
        .find((entry) => entry.path === path && paramsMatch(entry.url, expectedParams));
      return match?.url.toString() ?? null;
    })
    .not.toBeNull();
}

function paramsMatch(url: URL, expectedParams: Record<string, string | null>): boolean {
  return Object.entries(expectedParams).every(([key, expected]) => {
    const actual = url.searchParams.get(key);
    return expected === null ? actual === null : actual === expected;
  });
}

function presetSinceDate(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
