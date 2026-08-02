# Task 093: Persist enriched catalog evidence

## Problem

The crawler can successfully recover product-page prices after sitemap discovery, but report persistence keeps only the first 40 catalog records. Because enrichment targets can occur later in a large catalog, a live MyJam run fetched 16 product pages while its saved 40-product snapshot contained zero prices.

## Decision

At the persistence boundary only, create a stable price-prioritized sample: keep records with a valid observed numeric amount and currency first, preserve relative order within the priced and unpriced partitions, then apply the existing limit. Do not change product selection, matching, or comparison ordering.

Persist both sample and whole-catalog price counts so consumers can distinguish the intentionally biased snapshot from overall price coverage.

## Acceptance criteria

- Every price-bearing record survives when the number of priced records is at or below the snapshot limit.
- If priced records exceed the limit, the first priced records in original order are retained.
- Unpriced catalogs retain their existing order.
- `pricedProductCount` describes the persisted sample and `totalPricedProductCount` describes the full pre-compaction catalog.
- Existing catalog count and truncation fields remain accurate.
- Non-catalog blocks and the source document remain unchanged.
- Automated tests cover large, zero-price, over-limit, rival, and legacy/non-catalog cases.
- A fresh real MyJam production report persists non-zero primary-catalog price evidence after deployment.

## Data boundary

This task does not create, estimate, or infer prices. It only preserves already-observed price evidence in the bounded report snapshot and labels the sampling counts.

## Fable decision

Fable 5 approved a stable two-partition compaction at the persistence boundary and blocked any upstream reordering or unlabeled sample bias.
