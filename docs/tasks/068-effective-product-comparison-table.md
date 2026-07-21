# Task 068 — Effective product comparison table

## Outcome

Make the Table product layout behave like a real comparison table: one accepted product pair per semantic row, consistent columns, and a fast scan path from products to prices to decision.

## Customer problem

The current Table layout splits every pair across a summary row and a second details row. Prices are embedded in product cards, the columns do not form a conventional comparison grid, and the result takes more effort to scan than a normal product table.

## Decision

Use one header and one body with exactly one `tr` for each accepted pair. The desktop columns are:

1. **Your product** — observed image, product name, and first-party source link.
2. **Your price** — the saved comparable raw value when available, otherwise the first observed public price, or an explicit missing state.
3. **Closest rival** — rival domain, observed image, rival product name, and rival source link.
4. **Rival price** — the equivalent rival public-price state.
5. **Difference** — a percentage direction and absolute gap only when `resolvedPriceDelta(decision.priceComparison)` approves the pair; otherwise a clear coverage/basis state.
6. **Next move** — one concise action with an in-cell disclosure for match reasons, evidence state, observation date, and the evidence ledger.

The main row does not show inferred/confidence/verdict badges. Those technical states remain available inside “Why this match?” so they do not compete with the decision.

## Responsive behavior

- Desktop keeps a fixed-layout semantic table with aligned price columns and no minimum width that can force page scrolling.
- At tablet width, the same single `tr` becomes a two-column comparison record with visible cell labels; the DOM remains one semantic row per pair.
- At phone width, the record becomes one column with products followed by their prices, then difference and action.
- Product names and URLs wrap; the page must not gain horizontal overflow.
- RTL uses logical alignment and the same information order.

## Product-truth boundaries

- Do not parse visible price strings in the client to create a comparison.
- Show a numeric difference only through the existing saved `decision.priceComparison` and `resolvedPriceDelta` path.
- A missing public price remains visibly missing.
- Product and evidence source links remain attached to the row.
- No fixture products, prices, or images may be introduced.

## Acceptance criteria

1. The Table layout has one `thead`, one `tbody`, and exactly one data `tr` per accepted product pair.
2. Product identity, each observed price, defensible difference, concise action, match rationale, and source links are available in that row.
3. The six desktop columns align vertically and avoid card-within-card styling.
4. Technical evidence metadata is secondary and disclosed on demand.
5. Export CSV and Share remain available.
6. Keyboard users can open the match disclosure and follow every source link.
7. Desktop, tablet, phone, English, and Arabic layouts have no document-level horizontal overflow.
8. Tests enforce the single-row structure and price-comparison truth boundary.
9. A saved real MyJam report is visually checked after deployment.

## Fable 5 decision review

The verified Fable 5 CLI session reviewed the implementation strictly and returned four blockers. This task resolves them as follows:

1. Explicit `table`, `rowgroup`, `row`, `columnheader`, and `cell` roles preserve the comparison structure when responsive CSS changes native table display values.
2. Print CSS opens the match-detail body and hides its interactive summary so printed reports retain reasons, evidence state, and observation date.
3. Tablet and narrow-screen anchor offsets now clear their taller sticky navigation stacks.
4. This task amends Task 048 by moving claim type and confidence from the always-visible row into the keyboard-accessible “Why this match?” disclosure. The visible Difference cell still states whether a direct comparison is supported, missing, or basis-unverified; CSV retains claim type and confidence; and print expands the full truth metadata. This reduces scanning noise without presenting inferred matches as observed facts.

Fable also recommended tabular end-aligned prices, one price-gap computation per row, and bidirectional isolation for mixed Arabic/currency output; those low-cost improvements are included.

The strict re-review returned **PASS** after Fable inspected the updated diff and independently reran the two focused suites: 12/12 tests passed. The repository-wide validation passed 317/317 tests. Deployment and real-report visual validation remain merge prerequisites rather than code-review blockers.
