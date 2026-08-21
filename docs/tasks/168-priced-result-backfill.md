# Priced result backfill

## Problem

The live MyJam Agency report `4a9a78f9c4a442cea8d19cf21d2d224e` discovered 1,001 primary products but treated the 20-product entitlement as a pre-publication judge cap. Nine of the 20 accepted semantic pairs were later suppressed for missing valid prices, leaving only 11 publishable comparisons.

## Product contract

- A report product limit is a target for publishable, source-linked, same-market comparisons with finite positive supported-currency prices.
- Matching may screen a larger bounded pool to backfill rejected or unpriced candidates.
- Final customer-visible accepted comparisons must not exceed the persisted product limit.
- If the bounded catalog and search pool cannot fill the target, the report must expose the exact shortfall and evidence-backed exhaustion state.
- Price, market, source, and identity safety gates remain unchanged.

## Implementation

- Expand the internal matching pool independently from the customer-visible result target.
- Prefer candidate groups whose primary and rival records already contain valid public prices.
- Increase final enrichment capacity enough to cover backfill candidates.
- Apply the strict price publication gate, then retain the strongest publishable comparisons up to the persisted target.
- Record screened, published, target, and shortfall metrics separately.
- Update the product report metric to describe publishable compared products rather than pre-publication attempts.

## Validation

- Regression tests for candidate pool sizing, priced candidate priority, publication capping, and shortfall metadata.
- Matching route, lifecycle, orchestration, report UI, full test, lint, and build validation.
- Fresh live MyJam report on the 200-product plan proving 20 publishable priced comparisons, or an explicit bounded-exhaustion shortfall if the public market truly cannot supply 20.

## Data boundaries

Only attributable first-party public product pages may be published. Search or model output remains discovery/inference and cannot bypass price, source, market, currency, or identity validation.
