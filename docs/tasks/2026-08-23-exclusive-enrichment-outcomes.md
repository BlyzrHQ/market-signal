# Exclusive product-enrichment outcomes

## Problem

Production report `4d5bce140f124478b951ed1846ef2edf` found valid judged product pairs, but both enrichment batches were discarded. The enrichment endpoint could return one target as both a product and an unresolved adapter gap, while the durable checkpoint contract correctly requires exactly one outcome per target.

## Change

- Treat a product with an unresolved adapter price gap as a gap-only outcome so it can be retried safely.
- Preserve successful products from other targets in the same batch.
- Add regression coverage for the mutually exclusive product/gap contract.

## Validation

- Run focused storefront-enrichment and orchestration tests.
- Run the full typecheck, build, and test suite.
- Validate a fresh real public-domain report after Trigger-first and exact VPS deployment.

## Data boundary

The change does not invent prices or promote incomplete evidence. A target that still lacks attributable price evidence remains an explicit gap; independently successful targets remain eligible for durable persistence.
