# Research: Memory Filter Playwright

## Request

The user reported that Memory UI filters do not seem to be working and asked to "test all" by implementing a Playwright test.

## Current state

- `packages/ui` has no checked-in Playwright E2E test suite or Playwright config.
- `packages/ui` runs:
  - server/lib tests through `node --test`
  - React/app tests through Vitest
- A one-off `packages/ui/graph-drag-test.mjs` imports `playwright`, but `playwright` / `@playwright/test` are not direct `packages/ui` dev dependencies.
- CI currently runs `npm test` for `packages/ui` on Node 20 and Node 22. Adding Playwright to the default CI path would require browser install/setup changes; the focused path is to add an explicit `test:e2e` script first.

## Memory filter wiring

`packages/ui/app/src/pages/Memory.tsx` exposes:

- Search query
- Category filter
- Memory subtype filter
- Entity filter
- Sort order
- Usefulness filter
- `since` / `until` date range
- Destination selector through the shared API destination store

Browse requests include category, memory subtype, entity, sort, usefulness, `since`, and `until`.

Search requests include category, memory subtype, entity, sort, and usefulness, but currently omit `since` and `until`. That means date filters can silently stop applying when a search query is active.

## Test approach

- Add a Playwright test against the Vite dev server.
- Mock `/api/*` responses with `page.route()` so the test is deterministic and does not require live Qdrant credentials or seed data.
- Capture outgoing `/api/memory/browse` and `/api/memory/search` URLs to assert that every UI filter becomes the expected API query parameter.
- Add stable accessible labels to filter controls where needed so the test interacts like a user rather than through brittle CSS selectors.

## Scope

In scope:

- `packages/ui` Playwright config/script/dependencies
- Memory page filter accessibility labels
- Search request date filter forwarding
- A focused E2E test covering all Memory filters

Out of scope:

- Changing backend filter semantics
- Changing CI workflows unless explicitly approved
- Refactoring the Memory page beyond the filter controls needed for reliable testing
