# Wearform price and market integrity

## Problem

The live Wearform report `d16168850383428a92408b9e27e52ca2` published 18 accepted product matches, but 9 rows had no observed Wearform price. The bounded final-enrichment planner spent capacity on already-priced rival image gaps before primary-side price gaps.

The same report also accepted implausible Arklavo prices such as `USD 12000`. The current Arklavo product page exposes product-scoped direct metadata in GBP while contradictory JSON-LD labels a much larger value as USD. The extractor did not reconcile those sources.

## Product decision

- Complete accepted pairs' prices before spending final-enrichment capacity on images.
- Treat product-scoped direct price metadata and visible product price as stronger than contradictory JSON-LD. Reject the contradictory structured signal and record a machine-readable conflict attribute.
- A published price comparison requires finite positive observed prices on both sides, supported currencies, source URLs, observation timestamps, and exact currency equality. No silent FX conversion.
- A company may remain a market competitor when first-party evidence shows it serves that market, while incompatible-currency product offers are excluded from the price-comparison table.

Claude Fable 5 could not be started because the installed Claude client returned `unrecognized_model` / inaccessible model on 2026-08-16. Two independent Codex fallback reviewers were used under `AGENTS.md`; both identified blocking issues in earlier drafts. The final draft clears conflicting fresh price evidence instead of restoring stale values, prevents storefront adapters from reviving a page-level currency conflict, globally ranks atomic pair-enrichment work under the page cap, preserves excluded semantic matches with an explicit publication reason, validates source URLs and timestamps, and filters excluded records from the public price table.

## Validation

- Focused price, planner, and storefront suites: 184 tests passed.
- Full `npm test`: 775 tests passed, including type checks and production build.
- `npm run lint`: 0 errors and 2 pre-existing `<img>` performance warnings.
- Exact-head fallback re-review and production deployment remain pending.

## Acceptance criteria

- Under a tight page budget, missing prices that complete accepted pairs are selected before image-only targets.
- A product page with direct `GBP 100` metadata and contradictory `USD 12000` JSON-LD cannot produce the USD price.
- Missing-primary, missing-rival, and cross-currency pairs are not counted or displayed as published price comparisons, and suppression reasons are persisted.
- Existing same-currency, fully priced comparisons continue to publish.
- Focused tests, full test/build/lint, and real public Wearform and Arklavo probes pass.
- A fresh Wearform production report contains no published price row with a missing side or mismatched currencies.

## Data boundaries

All prices remain public observations with source URLs and observation timestamps. No exchange-rate conversion or inferred market currency is introduced. Semantic matches excluded from the price table remain available only as non-price evidence where the report schema supports that distinction.
