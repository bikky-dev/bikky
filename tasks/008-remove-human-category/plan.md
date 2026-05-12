# Plan: remove Human category

## Problem

The memory ontology currently exposes `human` as a first-class category. The requested taxonomy change is to remove that category completely, move `Preferences` to `Engineering`, and reclassify all former Human subtypes as Engineering in code, UI, docs, tests, and existing stored records.

## Proposed changes

1. Update the canonical taxonomy in `src/mcp/taxonomy.ts`.
   - Remove `human` from `CATEGORIES`.
   - Remove `human` from every domain `defaultCategories`.
   - Map `preference`, `person_profile`, `ownership_note`, `working_agreement`, and `activity_event` to `engineering`.
   - Replace `human.*` decay policy entries with `engineering.*` equivalents or rely on engineering defaults where appropriate.
   - Change legacy alias normalization so `human`, `people`, `person`, `owner`, `team`, `preference`, `agreement`, `activity`, and `actor` normalize to `engineering`.

2. Update daemon and prompt logic.
   - `src/daemon/capture-policy.ts`: remove the `human` default category mapping.
   - `src/daemon/extraction.ts`: make fallback hints for people/preferences/owners resolve to Engineering-backed subtypes.
   - `src/prompts/extraction.ts` and daemon default prompt text: remove Human as a top-level category and describe preferences/people/ownership/agreements/activity events under Engineering.
   - `src/prompts/brief.ts` and `src/daemon/consolidation.ts`: remove the Human heading/category and map legacy human-like categories to Engineering.
   - `src/daemon/staleness.ts` and `src/mcp/tools.ts`: remove `human` from category filters and heartbeat copy.
   - `src/daemon/relations.ts`: store inferred relation objects under Engineering instead of Human.

3. Update UI/API ontology and filters.
   - `packages/ui/src/routes/memory.ts`: remove `human` from category stats/options.
   - `packages/ui/src/lib/qdrant.ts`: route human-like legacy aliases to Engineering filters or remove the Human filter alias.
   - `packages/ui/app/src/lib/ontology.ts`: remove Human category option and put former Human subtypes under Engineering.
   - `packages/ui/app/src/lib/format.ts` and `packages/ui/app/src/pages/Graph.tsx`: remove canonical Human colors/legend and map legacy human-like categories to Engineering colors.
   - Update Playwright tests to use Engineering/Product only.

4. Update tests.
   - Core tests: `src/mcp/taxonomy.test.ts`, `src/daemon/capture-policy.test.ts`, `src/daemon/extraction.test.ts`, `src/mcp/helpers.test.ts`, `src/render.test.ts`.
   - UI route and E2E tests: `packages/ui/src/routes/memory.test.ts`, `packages/ui/app/e2e/memory-filters.spec.ts`.

5. Update docs.
   - `README.md`: replace the four-category explanation with Engineering/Product/System and mention preferences under Engineering.
   - Update any category-specific docs found during implementation.
   - Leave non-category uses of "human" alone, such as "human-readable", origin identity, or review lifecycle wording.

6. Add a dry-run-first backfill script.
   - Create `tasks/008-remove-human-category/artifacts/backfill-human-category.mjs`.
   - Default mode: dry-run, no mutations.
   - Apply mode: requires `--apply` and updates matching Qdrant points to `category: "engineering"` for configured destinations.
   - Include audit metadata such as `migration: "008-remove-human-category"` and the previous category.

7. Verification.
   - Run root checks: `npm test`.
   - Run UI checks: `cd packages/ui && npm test && npm run test:e2e && npm run build`.
   - Run the backfill script in dry-run mode and verify it reports the expected current counts.
   - After explicit user approval, run `--apply`, then re-run read-only counts to verify no `category=human` remains in configured destinations.

## Scope lock

- In scope: taxonomy/category logic, prompts, UI category presentation, tests, docs, and a safe Qdrant category backfill.
- Out of scope: unrelated provenance wording, broad refactors, changing domain names such as `personal_productivity`, changing source/provenance concepts, or removing ordinary non-category uses of the word "human".

## Approval needed before implementation

Approve this plan to start implementation. A separate explicit approval will still be required before running the data-mutating Qdrant backfill with `--apply`.
