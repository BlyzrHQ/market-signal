# Task 051 — Product-card prices

## Outcome

Keep each product's observed public price in the same visual card as its image and name. Use the central price-signal column only for the interpreted comparison result.

## Scope

- Show the primary and rival prices inside their respective product cards.
- Show an explicit localized `Price not observed` state when a product has no public price.
- Add a comparison-only mode to `PricePosition` so saved reports do not duplicate raw prices.
- Preserve the existing full price-position layout for every other caller.
- Validate the saved real report at desktop, tablet, and mobile widths.

## Truth boundary

This task changes presentation only. It does not infer missing prices or change product matching, scraping, or comparison eligibility.

## Acceptance criteria

- A product card contains its image (when observed), name, price state, and source link.
- Each raw product price appears once in the main comparison row.
- The price-signal cell contains only the comparison headline and a defensible gap.
- Missing prices are visibly labelled rather than silently omitted.
- English and Arabic states remain supported.
- Automated checks and responsive browser validation pass.

## Review

Fable 5 reviews the hierarchy and implementation strictly before merge. Codex independently verifies tests and the deployed report.

### Outcome

- Fable 5: `REVIEW: PASS` — no blocking issues; preserve the focused PR scope.
- Automated: 217 tests passed; lint completed with the two pre-existing `<img>` optimization warnings; production build passed.
- Real report: each product card contains one price state, the comparison-only signal contains zero raw-price values, and the 1280px viewport has no horizontal overflow.
