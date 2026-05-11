# Plan: Memory Playwright Edge Cases

## Problem

The existing Memory Playwright coverage verifies the main filter happy path, but it does not yet cover edge states that commonly regress: URL-restored filters, individual filter clearing, pagination, empty results, and API errors.

## Approach

Add focused tests to the existing Memory Playwright spec using the same mocked API pattern. Keep the default unit-test workflow unchanged.

## Planned changes

1. Update `packages/ui/app/e2e/memory-filters.spec.ts`.
   - Add a URL-preloaded filter test.
   - Assert the UI controls and active filter chips reflect URL query params.
   - Exercise individual active-filter clearing and assert only the cleared parameter is removed from API requests.
   - Add a load-more pagination test for browse mode.
   - Add empty and error state tests.

2. Update `packages/ui/app/src/pages/Memory.tsx` only for a small accessibility improvement.
   - Make active filter chip clear buttons include the filter value in their accessible label, so multiple active filters of the same type are uniquely identifiable.
   - Preserve visible UI and existing behavior.

3. Create a GitHub issue for this follow-up.
   - Reference the issue from the PR with `Closes #N`.

4. Verify.
   - Run `cd packages/ui && npm run test:e2e`.
   - Run `cd packages/ui && npm test`.
   - Run `cd packages/ui && npm run build`.
   - Run `cd packages/ui && npm audit --omit=dev --audit-level=high`.

## Out of scope

- Dashboard or Graph Playwright coverage.
- Backend route changes.
- Adding Playwright to default CI unless requested separately.
- Refactoring Memory page state management beyond the chip accessible-name improvement.

## Acceptance criteria

- Playwright covers Memory URL state, individual clearing, pagination, empty state, and error state.
- Tests remain deterministic and do not require live Qdrant.
- Existing UI package tests and build still pass.
