# Task 145 — Locale-redirect price enrichment

## Problem

The fresh US Wearform report `1808e13c2f9e447ebf8b74df6a7deac7` verified
Dickies but published no product comparisons. Dickies exposes current USD
offers in product JSON-LD, while requests to `/products/...` redirect to
`/en-us/products/...`. Final enrichment validated the product identity but did
not merge the priced record because the implicit-market source URL and its
explicit US redirect had different URL/market keys.

## Scope

- Treat a same-host product route with a newly inserted locale selector as the
  same redirect target when one side has no explicit market and neither side
  conflicts.
- Preserve the fail-closed boundary for two explicit but different markets,
  country-TLD conflicts, unrelated routes, and different product identities.
- Add focused regression coverage for the Dickies redirect shape.

## Validation

- Focused product-intelligence tests.
- Full tests, build, and lint.
- Strict Fable 5 review before merge.
- Trigger deployment before the exact VPS commit.
- Fresh Wearform report with only positive same-currency US comparisons.

