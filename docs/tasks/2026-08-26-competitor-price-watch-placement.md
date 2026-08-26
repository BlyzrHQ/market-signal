# Move price-watch controls to Competitors

## Goal

Keep the Products view focused on saved product comparisons and move all opt-in rival price-watch controls into the Competitors view.

## Product decision

- Rival-wide activation belongs with the rival, on the Competitors view.
- Individual saved-product URL switches remain available, grouped under the relevant rival.
- The Products table contains comparison evidence only; it no longer contains a watch column or price-watch panel.
- Monitoring remains private workspace functionality. Shared reports never expose watch controls.
- Existing watch APIs, credit accounting, cadence choices, and exact saved URL semantics are unchanged.

## Implementation

- Add a dedicated client component for competitor price-watch controls.
- Load authoritative saved matches on demand in bounded pages so individual switches use stable match IDs.
- Render the component only for authenticated workspace reports on the Competitors view.
- Remove watch state, network calls, panel markup, and the watch column from the Products component.
- Replace watch-column layout rules with responsive competitor watch-card rules.

## Validation

- `npm run typecheck` passed.
- `npm run lint` passed with zero errors and one pre-existing `@next/next/no-img-element` warning.
- `npm run build:vps` passed, including VPS bundle assertions.
- `npm test` passed: 1,203 tests, 0 failures.
- Static regression assertions confirm Products has no watcher UI, Competitors owns both rival and item activation, and shared reports omit private watcher controls.
- Verified Fable 5 independently reran the full test suite and lint, reviewed the exact final diff, and returned strict `PASS` with no actionable findings.
- Production workspace behavior will be recorded in the PR after deployment of the exact approved commit.

## Data boundaries

- No customer facts are changed.
- No watcher, billing, or credit schema is changed.
- The component reads only the report's existing authoritative match manifest and the signed-in workspace's watcher state.
