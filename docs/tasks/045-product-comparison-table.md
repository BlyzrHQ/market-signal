# Task 045 — Product comparison table

## Outcome

Replace the long stack of product-battle cards with a compact, evidence-aware comparison table that lets a customer scan many product pairs quickly.

## User problem

The current Products view repeats a large card for every match. Nine Babanuj comparisons require several screens of scrolling and make it hard to compare names, images, public prices, match quality, and recommended actions across rows.

## Proposed information architecture

Each accepted match becomes one semantic table row with five columns:

1. **Your product** — image when observed, name, public price or an explicit missing-price state, and first-party source link.
2. **Closest rival** — competitor domain, rival image, product name, public price or missing-price state, and rival source link.
3. **Price position** — both observed price labels plus the existing `PricePosition` result. The UI may derive its deterministic percentage/gap only through `resolvedPriceDelta` from a non-null saved `decision.priceComparison`; it must never parse or compare other visible price strings. Close substitutes show a concise “not a direct price comparison” state instead.
4. **Match evidence** — verdict, confidence, and the saved evidence terms/reasons.
5. **Recommended move** — the saved action and a link to the competitor evidence.

The table uses a strong pinned-style header, alternating row surfaces, image thumbnails, domain and confidence chips, and a narrow price-status rail so the eye can compare vertically.

## Responsive proposal

- Wide screens above 1180px use a real five-column HTML table. Its header sticks 64px below the route header, and columns have explicit width priorities instead of shrinking product names into narrow strips.
- At 1180px and below, each table row becomes a two-column comparison record: Your product and Closest rival stay side by side, followed by full-width price, match, and action cells. At 700px and below, the record becomes one column.
- The responsive transformation restores explicit `table`, `rowgroup`, `row`, `columnheader`, and `cell` roles and uses visible inline mobile labels. It does not rely on CSS-generated `data-label` content. The header remains available to assistive technology through a visually-hidden pattern instead of `display: none`.
- Missing images reserve no empty media box; missing prices remain explicit text.
- RTL reverses reading flow through logical properties while preserving Your product and Rival product labels.

## Acceptance criteria

- Render every accepted match exactly once.
- Preserve both source links, the competitor/evidence links, verdict, confidence, recommendation, images, and public price strings.
- Keep the existing `PricePosition` component. It may derive its exact percentage and absolute gap only with the existing `resolvedPriceDelta(decision.priceComparison)` path. Never compare or parse prices outside that saved server-approved pair.
- Keep product-enrichment gaps visible above the table.
- Use semantic table markup with useful column headers, explicit responsive roles, and visible inline labels at the stacked breakpoints.
- At 320px, transform rows into readable stacked comparisons with no document horizontal overflow and no clipped product names, prices, or actions.
- Preserve Arabic direction and keyboard-accessible links.
- Preserve the existing `rival-<domain>` and suffixed row IDs and hash scrolling used by inbound links from Competitors. Above 1180px, increase row scroll margin to clear both the 64px route header and sticky table header; preserve the existing compact margin when the table header is visually hidden.
- Repeat the Your-product cell when one primary has multiple rivals; do not use `rowspan` grouping.
- Use saved comparable raw prices in both product cells when `resolvedPriceDelta` succeeds; otherwise use each product's first observed price signal.
- Preserve the claim-type truth pill, string match confidence, price-verdict sentence, PricePosition method note, competitor dossier link, both product sources, and rival evidence link.
- Clamp long match reasons visually to two lines while retaining the complete text in the DOM.
- Validate on saved Babanuj report `491371d12fcd46189eff5f12c5b98b58`, containing nine accepted matches.

## Boundaries

- Presentation only; do not change matching, price extraction, persistence, or evidence semantics.
- Do not add client-side filtering or sorting in this task.
- Do not use placeholder products, images, or prices.

## Decision review

Fable 5 blocked the first proposal on three contradictions: the delta is deterministically derived in the UI from a saved server-approved pair rather than persisted as a percentage; CSS-generated mobile labels do not preserve accessible table semantics; and inbound rival row anchors were omitted. It also required a medium-width breakpoint, one price-string source of truth, retention of truth/method links, bounded reason density, repeated primary cells instead of `rowspan`, and a pinned real report. The revised proposal resolves each blocker. Fable's re-review cleared it for implementation with no blocker and identified one nuance now included above: wide row anchors must clear both sticky headers.

## Validation record

- Implemented the semantic five-column comparison table and its two responsive record layouts.
- `npm test`: 210/210 tests pass, including typecheck and production build.
- `npm run lint`: 0 errors; the two existing raw product-image warnings remain visible.
- `go test ./cli/... ./contracts/...`: pass.
- `git diff --check`: clean apart from the repository's existing CRLF conversion notices.
- Strict Fable 5 implementation review initially blocked sticky positioning on `thead` and the 1024–1180px row-anchor offset. The implementation was corrected to use sticky `th` cells, a 76px compact row offset, and a 118px wide-screen offset.
- Strict Fable 5 re-review: **PASS**. It verified the two corrections, semantic roles, real inline mobile labels, retained anchors/links, price-source truth, RTL-safe logical CSS, and the full automated suite.
- Pull request, exact-commit Sites deployment, and live desktop/mobile/RTL verification remain pending.
