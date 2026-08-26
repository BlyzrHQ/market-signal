# Split item and rival price-watch controls

## Goal

Correct the report workspace so each price-watch action appears at the level it controls:

- Products: one opt-in switch and cadence selector for each saved product comparison.
- Competitors: one rival-wide fixed-snapshot action and cadence selector for each rival.
- Shared/read-only reports: no private price-watch controls.

## Product boundaries

- An item switch creates, resumes, disables, or changes cadence for the exact saved match ID shown in its row.
- A rival-wide action sends the rival domain and uses the server-owned saved URL snapshot; it does not expose individual item controls in the Competitors view.
- Monitoring continues to use saved public URLs only and does not run search or AI.
- The change does not alter report facts, prices, matching, credits, billing, or watcher execution.

## Acceptance criteria

- Authenticated Products table shows item-level watch controls when price watch is available.
- Authenticated Competitors view shows rival-wide `Watch all` controls but no per-item disclosure or item switches.
- Shared reports do not request `/api/price-watch` and render no watcher controls.
- Existing watcher create/resume/disable/cadence behavior remains intact.
- Desktop and responsive report layouts remain usable without horizontal overflow.

## Validation

- Focused route/render tests: 15 passed, 0 failed.
- TypeScript: passed.
- Lint: passed with the existing `next/no-img-element` warning and no errors.
- VPS build and deployment assertions: passed.
- Full suite: 1,203 passed, 0 failed.
- Verified Fable 5 review: initial `STRICT PASS`; its two P2 state-synchronization findings were corrected by discarding stale watcher refreshes and clearing optimistic cadence overrides after success or failure.
- Final exact-commit review and authenticated production verification remain release gates.
