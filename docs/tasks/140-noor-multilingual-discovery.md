# Task 140 — Noor multilingual discovery recovery

## Problem

The fresh production Noor report `6ea1d9b6ed4a42ee8ee79dfee0e8454d`
observed 242 attributable first-party products but sent no rival domain to the
competitor crawler. Product search emitted useful Arabic and English query
variants in grouped web-search actions, while discovery only admitted an
inferred cross-language lead when the provider action contained exactly one
query. Company fallback also compared result titles only with the original
Arabic marketing-title terms, even when the search response supplied a concise
English category.

## Scope

- Preserve every provider query separately instead of joining grouped queries
  before source attribution.
- Admit a grouped-query product source only when one individual query is
  independently bound to the exact first-party product-detail path by the
  existing token and structural gates.
- Keep citations, collection/listing routes, weak joined-query matches,
  marketplaces, primary-brand stockists, and non-public URLs rejected.
- Allow entity/category source recovery to use the response's concise inferred
  category as an additional routing vocabulary. It remains an inferred lead;
  it is not published evidence and cannot bypass first-party crawl, product
  overlap, region, price, identity, or semantic verification.
- Expose a bounded lane gap when structured output exists but every candidate
  is rejected, so a zero-result report identifies discovery sanitation rather
  than implying that independent verification ran.

## Validation

- Add regression tests for individually bound multi-query product actions,
  joined-only false matches, collection/citation rejection, and cross-language
  category-source recovery.
- Run focused discovery and route/verification tests, then the full repository
  test, build, typecheck, and lint commands.
- Obtain strict Fable 5 PASS on the exact PR head, merge through Fable, deploy
  Trigger before the VPS exact approved commit, and verify production health.
- Run a fresh `noororganicfood.com` report. Acceptance requires at least one
  verified rival and one published product comparison with a finite positive
  supported-currency rival price.

## Boundaries

- Search queries and inferred categories are routing aids, never observed
  customer facts.
- A search source alone never becomes a verified competitor or product match.
- Existing exact-page, positive-price, supported-currency, category, identity,
  semantic, and regional gates remain unchanged.
