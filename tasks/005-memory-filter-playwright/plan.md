# Plan: Memory Filter Playwright

## Problem

The Memory UI exposes several filters, but there is no browser-level regression test proving that user interactions send the right API query parameters. A likely bug already exists: date range filters are not forwarded on search requests.

## Implementation plan

1. Create a tracking GitHub issue.
   - Describe the missing filter regression coverage and the search/date forwarding gap.

2. Add Playwright E2E support to `packages/ui`.
   - Add a direct Playwright test dependency.
   - Add `app/playwright.config.ts`.
   - Add a `test:e2e` npm script that runs the Playwright suite explicitly.
   - Keep default `npm test` unchanged to avoid CI browser setup changes.

3. Make Memory filter controls reliably testable and accessible.
   - Add `aria-label` attributes to sort, usefulness, entity, and date controls where labels are not otherwise programmatically associated.
   - Preserve current UI/visual behavior.

4. Fix search request filter forwarding.
   - Include `since` and `until` query parameters for `/api/memory/search` using the same ISO conversion as browse requests.

5. Add a deterministic Playwright test.
   - Mock stats, destination, browse, and search API responses.
   - Exercise category, subtype, entity, usefulness, date range, sort, destination, and search query interactions.
   - Assert the outgoing API URLs contain the expected filter parameters.

6. Verify.
   - Run `cd packages/ui && npm test`.
   - Run `cd packages/ui && npm run build`.
   - Run `cd packages/ui && npm run test:e2e`.

## Acceptance criteria

- A Playwright E2E test covers every visible Memory filter.
- Search requests preserve date range filters.
- The test does not require live Qdrant data.
- Default unit/build verification still passes.
- The Playwright suite can be run with an explicit script.
