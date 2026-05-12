# Research: remove Human category

## User intent

Remove `human` as a supported memory category everywhere. Move all former `human` subtypes to `engineering`, including `preference`, `person_profile`, `ownership_note`, `working_agreement`, and `activity_event`. Include an existing-data backfill/migration.

## Current taxonomy model

- Canonical categories live in `src/mcp/taxonomy.ts` as `engineering`, `product`, `human`, and `system`.
- `Category` is derived from `keyof typeof CATEGORIES`, so removing `human` updates MCP schema enum values, category descriptions, prompt rendering, and validation.
- `MEMORY_SUBTYPE_DEFAULT_CATEGORY` currently maps:
  - `preference` -> `human`
  - `person_profile` -> `human`
  - `ownership_note` -> `human`
  - `working_agreement` -> `human`
  - `activity_event` -> `human`
- `normalizeCategory()` currently maps aliases such as `human`, `people`, `person`, `owner`, `team`, `preference`, `agreement`, `activity`, and `actor` to `human`.
- `DECAY_HALF_LIFE` includes `human.*` policies; tests rely on human decaying slower than system.

## Code and logic surfaces

- Core taxonomy and MCP schema:
  - `src/mcp/taxonomy.ts`
  - `src/mcp/taxonomy.test.ts`
  - `src/mcp/tools.ts`
- Daemon capture/extraction:
  - `src/daemon/capture-policy.ts`
  - `src/daemon/capture-policy.test.ts`
  - `src/daemon/extraction.ts`
  - `src/daemon/extraction.test.ts`
  - `src/prompts/extraction.ts`
  - `src/prompts/brief.ts`
  - `src/daemon/staleness.ts`
  - `src/daemon/consolidation.ts`
  - `src/daemon/relations.ts`
- UI API and frontend:
  - `packages/ui/src/routes/memory.ts`
  - `packages/ui/src/lib/qdrant.ts`
  - `packages/ui/app/src/lib/ontology.ts`
  - `packages/ui/app/src/lib/format.ts`
  - `packages/ui/app/src/pages/Graph.tsx`
  - `packages/ui/app/e2e/memory-filters.spec.ts`
  - related route/frontend tests
- Docs:
  - `README.md`
  - potentially `docs/configuration.md` only where it discusses ontology/category language; ordinary phrases such as "human-readable" or origin user identity are not category references and can remain.

## Existing data impact

Read-only counts from configured Qdrant destinations:

| Destination | Collection | `human` total | `human` active | `preference` subtype | legacy `preferences` category | legacy `people`/`team` categories |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `perso` | `bikky` | 155 | 145 | 3 | 0 | 0 |
| `work` | `bikky` | 157 | 146 | 2 | 0 | 0 |

Subtype breakdown for `category=human`:

| Destination | `preference` | `person_profile` | `ownership_note` | `working_agreement` | `activity_event` | missing subtype |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `perso` | 3 | 0 | 4 | 8 | 137 | 3 |
| `work` | 2 | 0 | 2 | 8 | 144 | 1 |

The backfill should update at least all `category=human` records to `category=engineering`. It should also handle legacy category aliases defensively (`preferences`, `people`, `team`) even though the current count is zero.

The dry-run script found 312 total target records:

- `perso/bikky`: 155 points.
- `work/bikky`: 157 points.

## Constraints and risks

- Removing `human` from the canonical category enum will break tests and any callers still passing `category: "human"`. That is intended, but alias normalization should preserve compatibility by mapping old human-like category inputs to `engineering`.
- Existing Qdrant data must be mutated only after explicit user approval. The migration must support dry-run first.
- It is not necessary or desirable to remove every plain-English use of "human"; terms like "human-readable", "human identity", or "human-confirmed" are not the category and should remain unless directly tied to ontology/category docs.
- Existing untracked task folder `tasks/007-notion-memory-plan-update/` predates this work and should not be modified or reverted.

## Proposed migration/backfill behavior

- Add an idempotent migration script that:
  - reads configured destinations from `~/.bikky/config.json`;
  - scrolls for records whose `category` is `human`, `preferences`, `people`, or `team`;
  - groups matching point IDs by destination;
  - prints a dry-run summary by destination/category/subtype;
  - with an explicit `--apply`, calls Qdrant `points/payload` to set `category: "engineering"` and update an audit metadata marker.
- Do not run `--apply` until the user approves the exact operation and target destinations.
