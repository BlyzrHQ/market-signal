# Task 116 — Batch priced-match enrichment

## Problem

The live MyJam Agency report found 1,001 primary products, selected 1,000, AI-assessed 999, and accepted 301 candidate pairs. Only 41 pairs were published because 260 accepted pairs lacked a finite positive supported-currency rival price.

The final enrichment stage globally selects at most 64 product pages. The live run requested and fetched exactly 64 pages, so most accepted rivals never received a product-page price lookup before the strict publication gate ran.

## Decision

Keep the semantic threshold and strict rival-price publication gate unchanged. Enrich accepted product pages in bounded batches of at most 64, aggregate validated products and coverage, then publish only pairs whose rival has a finite positive supported-currency price.

## Scope

- Plan all eligible final-enrichment targets before applying a run-level cap.
- Split targets into independently bounded 64-page requests.
- Aggregate products, coverage, and gaps deterministically.
- Bound total pages and batches by the report product entitlement and orchestration deadline.
- Expose requested, fetched, eligible, and truncated coverage truthfully.
- Preserve source identity checks, robots policy, match thresholds, and price validation.

## Out of scope

- Lowering AI match thresholds.
- Publishing unpriced rivals.
- Adding new search providers or globally discovering more merchants.
- Changing the four paid-plan product limits.

## Acceptance

- Tests prove more than 64 accepted product pages are enriched across multiple calls while each call remains at or below 64.
- Tests prove partial batch failure is visible and successful earlier batches remain usable.
- Tests prove no unpriced rival is published.
- Full test, build/typecheck, and lint checks pass.
- Strict Claude Fable 5 review returns PASS before merge.
- Fresh MyJam Agency run persists plan `agency`, limit `1000`, assesses the bounded catalog, and publishes materially more than 41 valid-priced pairs without any invalid rival price or unsupported currency.

## Live baseline

- Report: `2763b26d79c34ba08aa5f704877d547b`
- 1,001 primary products available; 1,000 selected; 999 assessed.
- 301 accepted pairs before publication.
- 64 enrichment pages requested and fetched.
- 41 published/persisted pairs.
- 260 accepted pairs suppressed as `missing-valid-rival-price`.
- Zero invalid published rival prices.

## Fable decision

Claude Fable 5 rejected lowering semantic thresholds. It selected price extraction/enrichment coverage as the next focused task because the 86% post-match suppression is the largest and cheapest customer-value leak. Product-first merchant expansion remains the following task after this gate is no longer discarding most accepted pairs.
