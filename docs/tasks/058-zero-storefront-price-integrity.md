# Task 058 - Zero storefront price integrity

## Problem

The Task 57 MyJam production run displayed E-Grocers Spring Onions as `GBP 0`. The live WooCommerce Store API returned a zero minor-unit price and `is_purchasable: false`, while the product page's main price element was empty. Non-zero prices elsewhere on that page belonged to other products. The adapter incorrectly converted WooCommerce's empty-price sentinel into a public offer.

## Outcome

Keep the product name and secure image, but never present a WooCommerce zero price or calculate a delta from it in this task.

## Proposed rule

- A positive WooCommerce Store API price or range continues to work unchanged.
- The WooCommerce adapter never emits a zero-amount price signal. Zero, blank, null, boolean, or non-numeric price values retain the product and image with no `priceSignals` and return a user-visible adapter coverage gap. This deliberately avoids false positives such as “Free Range Eggs” and misconfigured purchasable products.
- Never borrow a price from related products, shipping thresholds, cart totals, or another variant.
- Preserve existing SaaS free-plan extraction; this change is limited to WooCommerce storefront adapter evidence.
- Preserve variable-price ranges only when both range endpoints are positive and valid. If either endpoint is zero/empty/invalid, retain no price signal and expose an incomplete-range gap so the positive endpoint cannot be mistaken for a fixed comparable price.

## Acceptance criteria

- The E-Grocers-shaped payload (`price: "0"`, `is_purchasable: false`) keeps its product/image but has no price and emits the explicit gap. Blank, null, boolean, and non-numeric fixed-price values behave the same way without JavaScript numeric coercion.
- A positive fixed WooCommerce price still parses exactly.
- A positive variable range remains a non-comparable range.
- A mixed zero-to-positive or blank-to-positive range retains no price signal, emits an explicit incomplete-range gap, and never creates a direct price delta.
- A purchasable zero-price product named “Free Range Eggs” still has no price signal. Supporting genuinely free retail items requires a later evidence-backed task; this task prefers unavailable over false certainty.
- Shopify's current zero-price behavior is pinned by a test because Shopify zero is merchant-entered rather than WooCommerce's observed empty-price sentinel.
- Existing SaaS free-plan tests remain green.
- Full tests, typecheck, lint, build, real E-Grocers adapter validation, strict Fable review, exact deployment, and a fresh MyJam production run pass before merge.

## Data truth boundary

`0` from the WooCommerce Store API can mean an unset or unavailable price. Market Signal must prefer “price unavailable” over false certainty. This task does not infer the related-product prices visible elsewhere on the HTML page and does not change SaaS free-plan extraction.

## Review record

Fable 5's first design review blocked accepting zero when `is_purchasable` and generic “free” wording were present, because grocery names such as “Free Range Eggs” would create false free offers. It also required pre-coercion tests for blank, null, and boolean values and fail-closed handling for partial ranges. The design adopted those requirements.

Fable 5's strict implementation review found no actionable blockers, independently ran 81 focused tests and the full 268-test suite, and returned `TASK 58 IMPLEMENTATION: PASS`.

## Validation record

- Focused product adapter, enrichment, and product-intelligence suites: PASS, 81/81.
- Full automated suite: PASS, 268/268.
- Typecheck and production build: PASS.
- Lint: PASS with zero errors and one pre-existing product-design-lab image warning.
- Secret diff scan: PASS.
- Live E-Grocers adapter check: `Spring Onions` and its HTTPS product image are retained; the false `GBP 0` is removed and replaced by the explicit coverage gap.
- Exact Sites deployment: PASS. Commit `70d726f32bb0e71a10964e934a4dd6c12864978a` was packaged and deployed as Sites version 97.
- Fresh MyJam production run: PASS for the integrity scope. Report `17f5f5377b404e82b2f0a95e3788e06d` (Trigger run `run_06fo0j9lvde1rn0r4jm7kef901`) persisted 13 events, 4 verified competitors, 600 primary products, 2,060 rival products, 30 verified product pairs, and 24/24 requested enrichment pages.
- The report finished `LIMITED`, not failed: 24 selected AI match assessments reached the bounded report deadline and were left unaccepted. The limitation is explicit in the persisted matching gaps.
- Persisted catalog integrity: zero zero-or-negative price signals and no rendered `GBP 0` price. Ads remain visibly source-limited where advertiser attribution is unavailable; the report does not turn missing access into a zero-ads claim.
- Browser QA on the persisted product table: 30 comparison rows, 60/60 product images loaded, no broken images, no false zero-price labels, and Export CSV/Share controls present.
- This rerun selected Oasis Market, My Meat Shop, Halal Fine Foods, and Damas Gate; E-Grocers was not rediscovered among the four strongest competitors. Therefore the exact E-Grocers sentinel was revalidated through the live adapter, while the fresh production report was independently checked across all persisted catalogs for any zero-or-negative storefront signal. The result does not claim an E-Grocers row existed in this rerun.
