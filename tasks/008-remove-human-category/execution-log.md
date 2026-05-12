## Status

| Phase | Status | Next step | Blockers |
| --- | --- | --- | --- |
| implement | in-progress | Apply code, docs, tests, and dry-run backfill script changes on `feat/remove-human-category-167` | Data backfill apply still requires separate user approval |

## Implementation Progress

- [x] Research existing taxonomy surfaces
- [x] Write plan and get approval
- [x] Create GitHub issue
- [ ] Implement approved code/docs/tests changes
- [ ] Prepare and approve data backfill
- [ ] Verify, commit, and open PR

## Timeline

- 2026-05-12 19:18 AEST — User requested moving `Preferences` to `Engineering` and removing the `Human` category from code, logic, documentation, and existing data.
- 2026-05-12 19:20 AEST — User confirmed scope includes a data migration/backfill for existing memories.
- 2026-05-12 19:21 AEST — Created task folder `tasks/008-remove-human-category/` and started research.
- 2026-05-12 19:25 AEST — User confirmed all former Human subtypes should move to Engineering.
- 2026-05-12 19:28 AEST — Counted configured Qdrant data read-only: `perso/bikky` has 155 `human` records; `work/bikky` has 157 `human` records.
- 2026-05-12 19:32 AEST — Wrote research and implementation plan.
- 2026-05-12 19:34 AEST — User approved implementation plan.
- 2026-05-12 19:35 AEST — Created GitHub issue #167 and branch `feat/remove-human-category-167`.
- 2026-05-12 19:44 AEST — Implemented taxonomy, daemon, UI, docs, tests, and dry-run backfill script changes.
- 2026-05-12 19:47 AEST — Verification passed: `npm test`, `cd packages/ui && npm test`, `cd packages/ui && npm run test:e2e`, `cd packages/ui && npm run build`, `npm run check`.
- 2026-05-12 19:48 AEST — Backfill dry-run reported 312 target points: 155 in `perso/bikky`, 157 in `work/bikky`; no data mutations performed.
- 2026-05-12 19:54 AEST — User approved Qdrant backfill apply. Applied migration to 312 target points, then verified a follow-up dry-run found 0 remaining target points.
- 2026-05-12 19:59 AEST — Legacy running MCP tooling created 2 additional `activity_event` points with `category=human` while recording the outcome. Re-ran the approved backfill guard, migrated those 2 points to Engineering, and verified the final dry-run found 0 remaining target points.
