# Task 066 — Complete selected-pair price coverage

## User outcome

Every selected product pair in the real MyJam report must show truthful public pricing on both sides. A fixed amount, a public range, or a clearly labelled from-price is acceptable. `Price not observed` is not acceptable for this 29-row corpus because the selected pages expose public price evidence.

## Fable 5 decision

Fable superseded its first catalog-persistence proposal after it failed the binding 29/29 metric. The approved architecture is a native TypeScript extraction and presentation change:

1. Keep ordinary robots-aware HTTP. Task 065 proved Scrapling fetched the same 29/29 pages and added zero prices or images.
2. Add a product-summary-scoped HTML price fallback after structured metadata/storefront evidence, including current sale prices.
3. Parse WooCommerce `data-product_variations` into truthful same-currency minimum/maximum signals.
4. Render multiple public variant amounts as a range and never use the range as an exact price delta.
5. Size selected-pair enrichment to the report rather than stopping at 24 pages, while retaining a hard ceiling, request timeout, byte limit, redirect policy, robots checks, and per-domain concurrency.
6. Preserve strict product identity and source attribution. Never use related-product prices.

## Acceptance gates

- Unit fixtures cover a scoped point price, sale markup, a WooCommerce variant range, a related-product trap, missing currency, and contradictory product identity.
- The final selected-pair target set can include both sides of all 29 report rows.
- Re-running `myjam.co.uk` yields 29 selected rows with a visible amount/range/from-price on both sides.
- Exact price deltas remain limited to a single aligned amount per side; ranges remain visibly non-comparable.
- Newly recovered rows pass a manual source-page audit with zero related-product or crossed-variant prices.
- Build, typecheck, lint, and relevant tests pass before review.

## Data-source boundary

All values come from the exact public product URL selected for a comparison. Public facts, range/basis limitations, and recommendations remain distinct. No anti-bot evasion, browser impersonation, fixture data, or fabricated price is introduced.

## Real-data validation

On 2026-07-21, `scripts/verify-selected-product-prices.mjs` ran the production TypeScript enrichment path against saved report `4a7a83e3503e4c36b948381be40ac07a`:

- 29 selected comparison rows
- 40 previously incomplete selected pages requested
- 40 pages accepted after robots, redirect, identity, and evidence checks
- 58/58 product-side price cells populated
- 0 unresolved enrichment gaps
- 8 WooCommerce variable products retained as ranges rather than false exact deltas

The recovered values were attached to each exact selected product URL. Related-product markup is cut from the extraction scope, and a regression fixture proves that a related `GBP 99.00` value cannot replace the selected product's `GBP 1.14` value.

## Strict Fable 5 review

Fable 5 returned **PASS** on 2026-07-21 after independently rerunning the 29-row verifier, the complete test/build/typecheck suite, lint, and a manual source audit of representative WooCommerce point and range prices. It reproduced 58/58 visible price cells with zero gaps, confirmed that ranges cannot create exact deltas, and found no related-product, crossed-variant, identity, robots, redirect, or concurrency blocker.

Known limitations remain visible rather than silently filled: nonstandard storefront themes can still defeat scoped extraction, slow domains can approach serverless runtime limits, and ranges preserve unresolved variant/pack alignment. The deployed site must be regenerated and verified from this exact commit before the PR is merged.
