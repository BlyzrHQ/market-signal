# Direct product-search results with mandatory prices

## Goal

Move ecommerce comparison search out of the crawl phase. After the primary catalog is crawled, search each priced primary product directly and retain every attributable product-page result that exposes a finite positive observed price, stopping at the purchased comparison count.

## Product contract

- Crawl collects the submitted website and its primary product catalog only.
- Comparison search runs after crawl, one primary product at a time in stable alphabetical order.
- A primary product can produce multiple comparison results, including multiple distinct product URLs from the same seller.
- Search-result relevance is not re-ranked or accepted/rejected by an AI semantic judge.
- A comparison is customer-visible only when both the primary and rival records have a real, finite, positive, supported-currency observed price and public source URL.
- Missing-price results are omitted; no empty-price placeholder is published.
- Stop once the persisted plan target (20, 50, 500, or 1,000 comparison pairs) is filled or the bounded primary catalog is exhausted.
- Paid search results are checkpointed so task replay does not purchase the same search again.
- Existing in-flight orchestration contracts retain the legacy path; newly dispatched reports use the direct-search contract.

## Validation

- Unit tests for multiple direct results per primary and per seller.
- Unit test proving missing, zero, negative, non-finite, raw-less, and unsupported-currency prices never publish.
- Unit test proving paid search checkpoint reuse.
- Route and orchestration contract tests for crawl/search separation.
- Typecheck, lint, build, and full test suite.
- Strict exact-head review before merge.
- Verify the deployed health and primary-only crawl path without launching a paid comparison search. Leave the first live Starter report to the user unless they explicitly authorize a paid acceptance run.

## Data boundaries

Search results are leads, not independently proven semantic equivalence. The customer report must describe them as search-linked comparisons. Product URLs and prices remain observed public-source facts with source and observation time; any recommendation remains labeled as a recommendation.

## Validation evidence

- `npm test`: 1,129 tests passed, 0 failed; includes typecheck, Node typecheck, and production build.
- `npm run lint`: 0 errors (two existing `no-img-element` warnings).
- Direct-search regression coverage proves empty and zero prices are omitted, valid positive prices remain, distinct URLs from one seller remain, and paid-search checkpoints are reused.
- Contract-v6 orchestration coverage proves crawl/search separation and persists 20 priced `search_result` facts without an AI semantic verdict.
- No paid live comparison search was launched during implementation.
