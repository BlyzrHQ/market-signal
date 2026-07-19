# Task 048: product-table visual hierarchy

## Problem

The saved-report product comparison view presents five equally prominent columns. Product identity, prices, match evidence, and recommendations all compete for attention; prices are repeated; and long evidence and action copy turns each row into a dense wall of text.

## Decision

Use a three-step desktop scan path:

1. **Product pair** — show both products together, their sources, the rival domain, and a compact visible match/truth state.
2. **Price signal** — show both observed prices and the defensible price verdict in one place only.
3. **Next move** — show one concise action without a permanent high-contrast background.

Keep detailed reasons, provenance, price methodology, the full price note, and the rival-evidence link in a native disclosure row directly beneath the comparison row. The disclosure remains associated with the semantic table through a full-width `colSpan` cell. Mobile presents the same hierarchy as a stacked card.

## Product-truth boundaries

- The observed/inferred badge and confidence remain visible before the disclosure is opened.
- Product source links remain attached to both products.
- Price direction is stated in text and never inferred from color alone.
- Missing or non-comparable prices retain an explicit coverage state.
- Detailed evidence remains available one keyboard interaction away.

## Acceptance criteria

1. Desktop comparisons use three primary columns: Product pair, Price signal, and Next move.
2. Each observed product price is rendered once per comparison row, inside Price signal.
3. Both product names, images when observed, source links, rival domain, match verdict, confidence, and truth state are visible without expansion.
4. The main action is a concise imperative summary; supporting rationale is secondary.
5. Detailed match reasons, price methodology/note, provenance, and rival evidence live in an accessible native disclosure row using valid table markup.
6. Keyboard users can reach and toggle each disclosure; focus styling is visible.
7. Arabic/RTL and narrow viewports retain the same reading hierarchy without horizontal overflow.
8. The sticky table header and dashboard tabs continue to work.
9. Tests cover the new semantic structure, single-location price presentation, responsive layout, and unique row anchors.
10. A saved real-data report is visually checked at desktop and mobile sizes after deployment.

## Fable 5 decision review

Model: `claude-fable-5`

Outcome: **PASS**, with mandatory safeguards applied to this task: keep the truth badge visible in the primary row, use a separate valid `tr > td[colSpan]` disclosure row, preserve text price direction, avoid a dominant action-column fill, and ensure export/print does not silently omit the detail.

Fable rejected styling-only changes to the five-column layout, hiding the action, replacing the disclosure with tooltips, and repeating prices across the product and price cells.
