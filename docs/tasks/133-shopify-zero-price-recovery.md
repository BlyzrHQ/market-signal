# Task 133 — Recover positive Shopify prices behind zero placeholders

## Problem

Some official Shopify product pages publish a zero-value JSON-LD offer while their same-domain public product JSON endpoint exposes the actual positive variant price. Market Signal treated the zero as a confirmed price, skipped the adapter, and consequently suppressed otherwise valid product comparisons.

## Scope

- Treat only finite, positive storefront prices as confirmed/comparable during selected-product enrichment.
- Discard zero or invalid page price signals before choosing between page and same-domain adapter evidence.
- Preserve the existing same-page currency requirement, robots policy, request budget, identity checks, and same-domain boundary.
- Add a regression matching the observed zero-placeholder plus positive Shopify `.js` response.

## Acceptance criteria

- A Shopify page with `price: 0` and `priceCurrency: USD` invokes its robots-allowed same-domain `.js` endpoint.
- A positive minor-unit adapter price is returned as the selected product price with the confirmed page currency.
- No off-domain, currency-inferred, zero, negative, or non-finite value becomes a comparable price.
- Focused tests, full tests/build/typechecks, and lint pass.
- The exact reviewed commit is deployed and validated against a fresh public Wearform report.

## Data boundaries

All recovered facts remain public observations tied to the official product page and its same-domain Shopify endpoint. Currency is accepted only when confirmed by the fetched product page; it is not guessed from locale or domain.
