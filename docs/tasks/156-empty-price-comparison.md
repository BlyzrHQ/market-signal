# Task 156 — Empty price-comparison normalization

## Problem

Asalbarri substitute rows have two valid public SAR prices, but the Difference column says “Comparable pair confirmed” and “Gap unavailable.” The authoritative match API exposes `priceComparison: { primaryRaw: "", rivalRaw: "" }` for non-identical products. That object is serialization residue, not an approved direct comparison.

## Change

- Preserve an absent or incomplete approved price pair as `null` when canonical report-match facts are written.
- Treat legacy empty approved-pair objects as absent when resolving a price claim.
- Keep a genuinely non-empty but unparseable approved pair in the existing `approved-unparsed` state.
- Allow existing reports to show the already-supported listed-price or unit-normalized comparison, with the explicit non-like-for-like qualification and no unsupported direct-match percentage.

## Validation

- Focused price-claim and report-fact canonicalization tests.
- Full test, VPS build, and lint suite.
- Live verification against Asalbarri report `1c64aef1c2dd497eacfe4e03a6a3ff3e` after deployment.

## Data boundaries

The UI derives only from public prices already stored with the report. It does not promote substitute products to exact matches. Exact percentages remain restricted to verified direct pairs or compatible unit-normalized evidence; listed-price gaps remain visibly qualified.
