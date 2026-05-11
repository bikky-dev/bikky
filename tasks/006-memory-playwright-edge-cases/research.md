# Research: Memory Playwright Edge Cases

## Request

Add more Playwright tests for Memory UI edge cases, building on PR #155.

Confirmed scope:

- URL-preloaded filter state
- Clearing individual and combined filters
- Load-more pagination
- Empty and error states
- Small Memory UI bug fixes exposed by those tests are in scope

## Current state

- `packages/ui` now has an explicit Playwright harness:
  - config: `packages/ui/app/playwright.config.ts`
  - suite directory: `packages/ui/app/e2e/`
  - command: `cd packages/ui && npm run test:e2e`
- Existing spec `memory-filters.spec.ts` covers the main filter-happy-path:
  - category
  - subtype
  - entity
  - usefulness
  - sort
  - date range
  - destination
  - search
  - clear-all request behavior
- Existing test mocks `/api/destinations`, `/api/memory/stats`, `/api/memory/browse`, and `/api/memory/search`, so no live Qdrant or config is required.

## Relevant Memory page behavior

- URL params initialize state for `q`, `category`, `memory_subtype`, `entity`, `sort`, `usefulness`, `since`, and `until`.
- Active filter chips are rendered for category, subtype, entity, usefulness, since, and until.
- Individual active filter chips currently share generic accessible names such as `Clear Category filter`; this is testable but less precise if multiple chips of one type exist.
- `Clear all` clears category/subtype/entity/usefulness/dates but intentionally keeps the search query and sort order.
- Browse load-more uses `offset=nextOffset` and appends returned results.
- Search load-more increases `limit` instead of using offset.
- Empty state renders `No facts found`.
- API errors render the error message from `apiFetch`.

## Repo guidance

- No repo-level Copilot instructions or `.github/agents` files were present.
- `CONTRIBUTING.md` requires an issue before non-trivial changes, branch from `main`, local tests before pushing, and a PR that closes the issue.
- Harness coding standards confirm TypeScript strict-mode expectations; existing project uses Node/npm and ESM, so follow the repo convention rather than migrating package managers.
- Harness git workflow requires short-lived feature branches, conventional commit messages, PRs for all changes, and explicit approval before merging to `main`.

## Proposed test additions

1. URL state + individual chip clearing
   - Navigate directly to `/memory` with several query params.
   - Assert controls and active filter chips reflect the URL state.
   - Clear individual chips and assert subsequent requests omit only the cleared parameter.
   - Improve chip clear button accessible names to include the chip value if needed.

2. Browse load-more pagination
   - Mock first browse response with `nextOffset`.
   - Click `Load more`.
   - Assert the next browse request includes `offset`.
   - Assert appended results and count text update.

3. Empty and error states
   - Mock an empty browse response and assert the empty state is shown.
   - Mock a failing browse response and assert the surfaced API error is shown.

## Files likely in scope

- `packages/ui/app/e2e/memory-filters.spec.ts`
- `packages/ui/app/src/pages/Memory.tsx` only if tests expose accessibility gaps on active filter chips
- `tasks/006-memory-playwright-edge-cases/*`

## Verification

- `cd packages/ui && npm run test:e2e`
- `cd packages/ui && npm test`
- `cd packages/ui && npm run build`
- `cd packages/ui && npm audit --omit=dev --audit-level=high`
