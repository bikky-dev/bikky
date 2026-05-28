# Research: Notion Memory Plan Update

## Request

Update the Bikky project board for Memory UI work and the related plan.

Confirmed desired update:

- Mark the completed Memory UI Playwright/filter work as done.
- Add notes/links for PR #155 and PR #166 to the plan.

## Context

Recent completed work:

- PR #155: `test: cover Memory UI filters with Playwright`
  - merged to `main` at `64ef070`
  - closed issue #154
  - added explicit Playwright E2E coverage for Memory UI filters
  - added visible Entity filter and accessible filter labels
  - fixed search requests to forward `since` / `until`
- PR #166: `test: add Memory Playwright edge cases`
  - merged to `main` at `108c9bc`
  - closed issue #165
  - added Memory UI Playwright edge-case coverage for URL-preloaded filters, individual filter clearing, browse load-more pagination, empty state, and API error state
  - updated active filter clear buttons to include filter values in accessible labels

## Access resolution

The built-in Notion API tool is still configured with an invalid token. The valid token is available in 1Password:

- vault: `agent00`
- item: `notion-api-key`
- field: structured JSON field `credential`
- bot identity: `synapse-agent`

Do not use `op item get ... --fields credential` for this item; that returned an invalid/incorrect value shape during research. Use the structured JSON field value instead:

```bash
op item get cmqh7fwcsk3kwanzvsp7hgguoy --vault agent00 --format json \
  | jq -r '.fields[] | select(.id=="credential").value'
```

## Notion records found

- `Bikky Tasks`: `35988a57-98a3-81a7-81aa-f50e41a01531`
- `Bikky Epics`: `35988a57-98a3-8140-b7ec-e902ce296463`
- `Bikky HQ`: `34d88a57-98a3-816c-815d-fc24cf7cb446`
- E5 epic: `35988a57-98a3-8155-a81e-e38863bf2c66` — `E5 - Memory quality, telemetry, and review UX`
- T-E5-03: `35988a57-98a3-8197-8e04-e4b5a3dbe94e` — `Build quality dashboard and review queues`

## Finding

The board has E5 memory-quality/review tasks, but no dedicated task rows for PR #155 or PR #166. T-E5-03 is related UI work but broader than the completed Memory filter/test work, so marking T-E5-03 done would overstate roadmap completion.

## Recommended next step

Create dedicated Done task rows under E5 for the two completed Memory UI Playwright/filter deliverables, and append a concise progress note to the Bikky HQ plan page with PR links.

## Applied update

- Created/verified `T-E5-04 - Add Memory UI filter Playwright coverage` as Done:
  - page: `35e88a57-98a3-81c6-a90a-fd95705c8e88`
  - PR: <https://github.com/bikky-dev/bikky/pull/155>
  - issue: <https://github.com/bikky-dev/bikky/issues/154>
- Created/verified `T-E5-05 - Add Memory UI Playwright edge-case coverage` as Done:
  - page: `35e88a57-98a3-8164-a3a9-ca635021c3ce`
  - PR: <https://github.com/bikky-dev/bikky/pull/166>
  - issue: <https://github.com/bikky-dev/bikky/issues/165>
- Appended `Memory UI filter/Playwright progress` to Bikky HQ `34d88a57-98a3-816c-815d-fc24cf7cb446`.
