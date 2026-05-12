import { expect, test, type Page } from "@playwright/test";

interface CapturedRequest {
  path: string;
  url: URL;
}

interface BrowseResponse {
  results: ReturnType<typeof memoryFact>[];
  count: number;
  nextOffset: number | null;
}

interface SearchResponse {
  results: ReturnType<typeof memoryFact>[];
  count: number;
}

interface MockErrorResponse {
  status: number;
  error: string;
}

interface MockMemoryApiOptions {
  browse?: (url: URL) => BrowseResponse | MockErrorResponse;
  search?: (url: URL) => SearchResponse | MockErrorResponse;
}

const categoryCounts = {
  engineering: 6,
  product: 3,
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

test("Memory restores URL filter state and clears individual active filters", async ({ page }) => {
  const captured: CapturedRequest[] = [];
  await mockMemoryApi(page, captured);

  const expectedSince = new Date("2026-01-02").toISOString();
  const expectedUntil = new Date("2026-01-09T23:59:59").toISOString();

  await page.goto(
    "/memory?category=product,engineering&memory_subtype=product_decision&entity=bikky-ui&usefulness=positive&since=2026-01-02&until=2026-01-09&sort=oldest",
  );

  await expect(page.getByRole("combobox", { name: "Sort memories" })).toHaveValue("oldest");
  await expect(page.getByRole("combobox", { name: "Usefulness filter" })).toHaveValue("positive");
  await expect(page.getByRole("textbox", { name: "Entity filter" })).toHaveValue("bikky-ui");
  await expect(page.getByLabel("From date")).toHaveValue("2026-01-02");
  await expect(page.getByLabel("Until date")).toHaveValue("2026-01-09");
  await expectRequest(captured, "/api/memory/browse", {
    category: "product,engineering",
    memory_subtype: "product_decision",
    entity: "bikky-ui",
    usefulness: "positive",
    since: expectedSince,
    until: expectedUntil,
    sort: "oldest",
    destination: "all",
  });

  await page.getByRole("button", { name: "Clear Category filter Product (3)" }).click();
  await expectRequest(captured, "/api/memory/browse", {
    category: "engineering",
    memory_subtype: "product_decision",
    entity: "bikky-ui",
    usefulness: "positive",
    since: expectedSince,
    until: expectedUntil,
    sort: "oldest",
    destination: "all",
  });

  await page.getByRole("button", { name: "Clear Subtype filter Product decision (2)" }).click();
  await expectRequest(captured, "/api/memory/browse", {
    category: "engineering",
    memory_subtype: null,
    entity: "bikky-ui",
    usefulness: "positive",
    since: expectedSince,
    until: expectedUntil,
    sort: "oldest",
    destination: "all",
  });

  await page.getByRole("button", { name: "Clear Entity filter bikky-ui" }).click();
  await expectRequest(captured, "/api/memory/browse", {
    category: "engineering",
    memory_subtype: null,
    entity: null,
    usefulness: "positive",
    since: expectedSince,
    until: expectedUntil,
    sort: "oldest",
    destination: "all",
  });

  await page.getByRole("button", { name: "Clear From filter 2026-01-02" }).click();
  await expectRequest(captured, "/api/memory/browse", {
    category: "engineering",
    memory_subtype: null,
    entity: null,
    usefulness: "positive",
    since: null,
    until: expectedUntil,
    sort: "oldest",
    destination: "all",
  });

  await page.getByRole("button", { name: "Clear all" }).click();
  await expectRequest(captured, "/api/memory/browse", {
    category: null,
    memory_subtype: null,
    entity: null,
    usefulness: null,
    since: null,
    until: null,
    sort: "oldest",
    destination: "all",
  });
});

test("Memory browse appends results when loading more", async ({ page }) => {
  const captured: CapturedRequest[] = [];
  await mockMemoryApi(page, captured, {
    browse: (url) => {
      const offset = url.searchParams.get("offset");
      return {
        results: [memoryFact(offset === "20" ? "browse-page-2" : "browse-page-1", url)],
        count: 2,
        nextOffset: offset === "20" ? null : 20,
      };
    },
  });

  await page.goto("/memory?sort=newest");

  await expect(page.getByText("Mock browse-page-1 memory for /api/memory/browse")).toBeVisible();
  await expect(page.getByText("Showing 1 of 2 facts")).toBeVisible();

  await page.getByRole("button", { name: "Load more" }).click();

  await expectRequest(captured, "/api/memory/browse", {
    offset: "20",
    limit: "20",
    sort: "newest",
    destination: "all",
  });
  await expect(page.getByText("Mock browse-page-1 memory for /api/memory/browse")).toBeVisible();
  await expect(page.getByText("Mock browse-page-2 memory for /api/memory/browse")).toBeVisible();
  await expect(page.getByText("Showing 2 of 2 facts")).toBeVisible();
});

test("Memory shows empty and error states", async ({ page }) => {
  const captured: CapturedRequest[] = [];
  let failBrowse = false;
  await mockMemoryApi(page, captured, {
    browse: (url) => {
      if (failBrowse) return { status: 503, error: "Qdrant is unavailable" };
      return { results: [], count: 0, nextOffset: null };
    },
  });

  await page.goto("/memory?category=product");
  await expect(page.getByText("No facts found")).toBeVisible();
  await expect(page.getByText("Try adjusting your search or filters")).toBeVisible();
  await expectRequest(captured, "/api/memory/browse", {
    category: "product",
    destination: "all",
  });

  failBrowse = true;
  await page.goto("/memory?category=engineering");

  await expect(page.getByText("Qdrant is unavailable")).toBeVisible();
  await expectRequest(captured, "/api/memory/browse", {
    category: "engineering",
    destination: "all",
  });
});

async function mockMemoryApi(
  page: Page,
  captured: CapturedRequest[],
  options: MockMemoryApiOptions = {},
) {
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
      const response = options.search?.(url) ?? {
        results: [memoryFact("search-result", url)],
        count: 1,
      };
      await route.fulfill({
        status: "status" in response ? response.status : 200,
        contentType: "application/json",
        body: JSON.stringify(responseBody(response)),
      });
      return;
    }

    if (url.pathname === "/api/memory/browse") {
      const response = options.browse?.(url) ?? {
        results: [memoryFact("browse-result", url)],
        count: 1,
        nextOffset: null,
      };
      await route.fulfill({
        status: "status" in response ? response.status : 200,
        contentType: "application/json",
        body: JSON.stringify(responseBody(response)),
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

function responseBody(response: BrowseResponse | SearchResponse | MockErrorResponse) {
  return "status" in response ? { error: response.error } : response;
}

function memoryFact(id: string, requestUrl: URL) {
  const entity = requestUrl.searchParams.get("entity");
  return {
    id,
    content: `Mock ${id} memory for ${requestUrl.pathname}`,
    category: requestUrl.searchParams.get("category")?.split(",")[0] || "engineering",
    domain: "software_engineering",
    kind: "fact",
    memory_subtype: requestUrl.searchParams.get("memory_subtype"),
    entities: entity ? [entity] : ["bikky-ui"],
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
