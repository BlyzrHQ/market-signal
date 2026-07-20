# Task 062 - Family-level competitor discovery fallback

## Problem

Fresh production report `e708dc4399854a6b87faace9b913e0e0` for `al-hamdanisweets.com` collected 51 attributable first-party products, but returned no verified competitors. Both company-level lanes reached their 24-second timeout. Four product lanes completed, but their anchors favored unusually specific names such as `Ballourie Orange Pistachio Baklava` and `Awamat Doughnut Ball`. They returned queries but no attributable rival product-detail source, leaving the verifier with no candidate domain to crawl.

Current public search checks show that representative family names from the same catalog do expose first-party US seller product pages. For example, `Pistachio Baklava` surfaces public product pages on `usabakelava.com` and `vefabaklava.com`, while `Walnut Baklava` surfaces `ramallahmarket.com`. Those domains are leads only; they still must pass the existing independent crawl, target-region, category-alignment, and verification-score gates before appearing in a report.

## Outcome

When company-level discovery is slow or sparse, use the existing bounded product lanes more effectively by selecting representative, searchable product-family anchors from the observed catalog. Do not add extra web-search calls, weaken source attribution, or bypass competitor verification.

## Proposed behavior

- Rank attributable ecommerce products by catalog representativeness before selecting the existing maximum of four product searches.
- Prefer concise names whose meaningful tokens recur across the first-party catalog. This should choose a representative family item such as `Pistachio Baklava` ahead of a longer niche variant such as `Ballourie Orange Pistachio Baklava`.
- Preserve product-family diversity by grouping candidates on their strongest recurring catalog token and selecting at most one anchor per group before filling any remaining slots.
- Keep extraction quality, structured price presence, and source order only as deterministic tie-breakers; an unpriced sitemap product may be a better discovery anchor than a priced niche variant.
- Keep all existing product-source gates: a returned lead must be a first-party seller product-detail URL, match at least two meaningful product tokens at the existing coverage threshold, differ from the primary brand/domain, and survive the live competitor crawl and verification threshold.
- Keep the total discovery request count unchanged: two company-level lanes plus at most four product lanes.
- Expose the selected family queries and any lane timeout in the existing market-profile coverage state.

## Acceptance criteria

- An Al-Hamdani-shaped catalog selects `Pistachio Baklava` and `Maamoul Pistachio` (or equally concise representative family records) before niche variants.
- A MyJam-shaped grocery catalog remains diverse across product families rather than spending all four searches on one meat type.
- A small catalog retains deterministic source order and never exceeds four product searches.
- Product-search results remain source-backed leads; no model-only domain or URL enters candidate investigation.
- Entity/category timeout behavior remains visible and does not discard completed product-lane candidates.
- Existing exclusion, deduplication, same-brand, publisher, marketplace, product-detail, region, crawl, and verification tests remain green.
- The exact reviewed commit is deployed to Sites and Trigger, then a fresh `al-hamdanisweets.com` report is inspected in the browser. Completion requires at least one independently verified competitor with a public comparable product, or a new source-linked gap proving why each returned lead failed verification.

## Data truth boundary

Search results are candidate leads, not report facts. A company is shown only after its own public site confirms category and market alignment and the existing verification score accepts it. Product-name recurrence is used only to choose better search anchors; it never proves that two products or companies are competitors.

## Out of scope

- Increasing the number of paid search calls.
- Increasing the 24-second lane timeout.
- Weakening target-region or competitor verification thresholds.
- Product-pair AI judging, price comparison, or ad-library coverage changes.

## Review record

Fable 5 returned `TASK 62 DESIGN: PASS`. It approved recurrence-ranked, family-diverse anchors as the safest useful fallback because request caps and every source, crawl, region, and verification gate remain unchanged. It required brand-token removal, a real two-pass family selector, a total-order comparator, recurrence over the full first-party catalog, shaped sweets and grocery fixtures, and an explicit timeout-retention regression test.

Fable 5 returned `TASK 62 IMPLEMENTATION: PASS`. It verified brand stripping, the two-pass family collision path, deterministic recurrence/conciseness/quality/source-order ranking, full-catalog recurrence, the unchanged four-product-search cap, and the unchanged source and verification gates. It independently reran the full 299-test suite plus typecheck, production build, and lint (zero errors and one pre-existing warning).

The persisted Al-Hamdani catalog now selects `Pistachio Baklava`, `Ballourie Pistachio`, `Maamoul Walnut`, and `Sesame Cookie with Dates` as its four bounded anchors. This includes broad baklava and maamoul families and replaces the prior price-biased niche set without adding a request.
