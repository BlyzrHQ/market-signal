# Task 052 — Product layout lab, export, and share

## Outcome

Add three genuinely different ways to inspect the same saved product-comparison evidence so the preferred design can be chosen from the live product. Add export and share controls without changing any report facts.

## Layouts

1. **Table** — a compact audit view for scanning names, observed prices, signal, and next move.
2. **Matchups** — visual side-by-side product cards for evaluating one pair at a time.
3. **Opportunities** — a decision board that groups every pair into price pressure, your edge, or needs evidence based only on the saved comparison state.

## Interaction

- Persist the selected layout in the report URL as `layout=table|matchups|opportunities`.
- Support browser Back/Forward and keyboard tab navigation.
- Export every saved pair as UTF-8 CSV with raw prices, parsed amount/currency when defensible, comparison status, match status, action, observed date, and sources.
- Share the exact product-layout URL through the native share sheet when available, then clipboard fallback, then a selectable URL if both fail.

## Truth boundary

- All layouts render the same saved pairs. They do not refetch, rematch, infer prices, or alter actions.
- A price advantage or pressure lane requires a server-approved comparable price delta.
- Missing or basis-unverified prices remain explicit and route only to `Needs evidence`.
- Useful data-gap actions remain visible; they are not presented as pricing conclusions.
- Match basis, confidence, observed date, and sources remain available on demand in every layout.

## Acceptance criteria

- Table rows, matchup cards, and the sum of opportunity cards have identical pair counts.
- The table is semantic and horizontally contained on narrow screens.
- The layout control is a keyboard-operable tablist with active state.
- Export contains the full product comparison, independent of the active layout.
- Share includes both `view=products` and the active `layout` query parameter.
- English and Arabic labels remain supported.
- A real saved report is checked in all three layouts before deployment.

## Fable decision

Fable 5 returned `DECISION: PASS`. It confirmed that the three layouts answer distinct scan, focus, and prioritization jobs. Its data-parity, URL-state, export, share, truth-boundary, and accessibility safeguards are adopted. The suggestion to hide all actions when a price is missing is intentionally rejected: a clearly phrased data-gap action such as exposing a public price is useful and does not claim a competitive price conclusion.

## Validation

- Typecheck and production build passed.
- All 217 automated tests passed; lint completed with zero errors and one expected external-product-image warning.
- Browser validation against saved real report `1d787f02518a44f899b1624e350c354a` confirmed equal pair counts across Table, Matchups, and Opportunities, three opportunity lanes, no page-level horizontal overflow, exact layout URLs, and working Back/Forward state.
- Fable 5 reviewed the complete staged implementation as the strict merge gate and returned `REVIEW: PASS`.
