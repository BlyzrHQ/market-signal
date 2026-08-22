# Exclusive product-enrichment outcomes

## Problem

Production report `4d5bce140f124478b951ed1846ef2edf` found valid judged product pairs, but both enrichment batches were discarded. The enrichment endpoint could return one target as both a product and an unresolved adapter gap, while the durable checkpoint contract correctly requires exactly one outcome per target.

## Change

- Treat a product with an unresolved adapter price gap as a gap-only outcome so it can be retried safely.
- Preserve successful products from other targets in the same batch.
- Reject non-HTTP(S) enrichment sources before they can become durable or suppress a valid product.
- Re-fetch adapter-limited targets on a later bounded task attempt so a temporary adapter outage is not made permanent.
- Add regression coverage for the mutually exclusive product/gap contract, invalid source schemes, and adapter recovery.

## Validation

- Run focused storefront-enrichment and orchestration tests.
- Run the full typecheck, build, and test suite.
- A fresh real public-domain report requires explicit approval because the owner paused paid API-key usage; deployment validation must not launch one implicitly.

## Review

Two independent fallback reviewers found blockers on the first head: invalid URL schemes could suppress valid products, and adapter-limited gaps were not retryable. Both are addressed by the protocol validation and bounded retry behavior above. Fresh exact-head reviews are required before merge.

## Data boundary

The change does not invent prices or promote incomplete evidence. A target that still lacks attributable price evidence remains an explicit gap; independently successful targets remain eligible for durable persistence.
