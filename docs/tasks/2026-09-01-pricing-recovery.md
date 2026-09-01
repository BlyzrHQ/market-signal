# Pricing recovery for public storefront catalogs

## Problem

Recent production reports exposed several independent ways that positively priced first-party products are lost before comparison search begins:

- a sitemap child was ranked by its full URL, so a hostname containing `product` made every child look product-related and could exclude the actual product sitemap;
- transient HTTP 429 responses were terminal and the two same-domain workers retried nothing;
- Shopify product JSON was never attempted when the HTML product page returned 403 or 429;
- Shopify product JSON prices were discarded when the page omitted currency even though the same storefront's official cart endpoint exposed the active currency; and
- variant-heavy catalogs could spend the complete bounded price budget on repeated product families.

These are public crawl/data-quality defects. This task does not change paid comparison search, customer plan limits, or report ownership.

## Product-truth boundaries

- Publish only finite positive prices with a supported ISO currency.
- Shopify legacy product JSON may provide amounts, but those amounts are accepted only when the exact product handle is returned and the active currency is confirmed by non-conflicting first-party page evidence or the same-origin official cart JSON.
- A URL-selected market is never qualified by an unscoped cart currency.
- A locale-prefixed product URL and a country-scoped blocked-page recovery never borrow a root-market cart currency.
- Redirects remain same-domain and robots policy remains authoritative.
- Retry only idempotent public GET requests and keep attempts, delay, concurrency, and response size bounded.
- Surface unresolved fetch and currency gaps; do not convert missing evidence into zero or an estimate.

## Implementation

1. Rank child sitemaps from their decoded path, preferring product/catalog paths before generic content sitemaps.
2. Add one bounded retry for HTTP 429/502/503/504 responses, respecting a capped `Retry-After` value and serializing same-domain retry waits.
3. Recover exact Shopify or WooCommerce structured product endpoints when product-page HTML is unavailable.
4. Confirm otherwise-missing Shopify currency from same-origin `/cart.js`, cached once per origin, while preserving market-conflict checks.
5. Select one unpriced target per normalized product family before spending remaining capacity on repeated variants.

## Acceptance criteria

- A Fellow-style sitemap index always selects `sitemap_products_*.xml` even when `products` appears in the hostname.
- A product page that returns HTTP 429 once is retried once and can recover a verified positive price.
- A blocked Shopify HTML page can recover an exact-handle positive price through official product and cart JSON.
- A Shopify page without direct currency can use a non-conflicting same-origin cart currency, but a URL-selected market cannot.
- Locale-prefixed products and blocked-page recoveries carrying `marketCountryCode` remain currencyless unless market-scoped evidence is available.
- The first bounded target wave covers distinct normalized product families before duplicate variants.
- Focused tests, full typechecks/build/test/lint, and `git diff --check` pass.
- At least Fellow and Tentree are validated against current public data without starting paid comparison search.

## Deployment and validation record

- Focused pricing regressions: 121/121 passed after the strict-review market-scope fixes.
- Application and Node typechecks: passed.
- Full application build and test suite: 1,266/1,266 passed after review fixes.
- VPS production build: passed; `better-sqlite3` remains external as required.
- Lint: passed with the existing `app/components/product-design-lab.tsx` raw-image warning and no errors.
- `git diff --check`: passed (Git emitted only Windows line-ending notices).
- Current public-domain validation on 2026-09-01, with no paid comparison search:
  - `fellowproducts.com`: product sitemap coverage increased from the reproduced six-product failure to 302 discovered catalog products; a bounded 20-target enrichment recovered 20/20 additional positively priced products (4 before, 24 after).
  - `tentree.com`: 4,000 sitemap product URLs were observed; a bounded, diverse 20-target enrichment recovered 20/20 positively priced products from a zero-priced starting selection, with no unresolved target gaps.
- Strict review, merge, exact-revision deployment, and production verification remain pending.
