# Task 131: Seed verified Wearform competitor product pages

## Problem

The live Wearform report extracts 753 first-party products and discovers six plausible competitors, but publishes no competitors or comparisons because no rival product-detail URL survives discovery verification. A representative official CustomInk product URL uses the plural token `t-shirts`, while the matching Wearform catalog product uses `T-Shirt`; the matcher treats those tokens as different and rejects the source at its 60% path-coverage threshold.

## Scope

- Normalize conservative trailing-`s` product-token plurals for search-source matching.
- Permit two-token product-detail paths at 50% primary-product coverage.
- Preserve rejection of homepages, publisher pages, marketplaces, primary-brand sources, and category pages such as `/collections/products`.
- Add a Wearform-to-CustomInk regression test.

## Validation

- Focused competitor-discovery tests.
- Full tests, build/typecheck, and lint.
- Strict Fable 5 review before merge.
- Deploy the exact reviewed commit and generate a fresh public Wearform report.
- Completion requires at least one verified competitor and at least one published product comparison with a finite positive rival price and supported currency. If that outcome is not reached, record the next observed bottleneck and keep the task open.

## Data boundaries

Search results only seed candidate product URLs. A competitor is still published only after the existing first-party crawl and product-overlap verification succeeds. Missing or inaccessible rival data remains a visible coverage gap.
