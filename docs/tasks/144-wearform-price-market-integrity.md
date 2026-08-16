# Wearform price and market integrity

## Problem

The live Wearform report `d16168850383428a92408b9e27e52ca2` published 18 accepted product matches, but 9 rows had no observed Wearform price. The bounded final-enrichment planner spent capacity on already-priced rival image gaps before primary-side price gaps.

The same report also accepted implausible Arklavo prices such as `USD 12000`. The current Arklavo product page exposes product-scoped direct metadata in GBP while contradictory JSON-LD labels a much larger value as USD. The extractor did not reconcile those sources.

## Product decision

- Complete accepted pairs' prices before spending final-enrichment capacity on images.
- Rank pair enrichment lexicographically by match score and schedule each pair atomically. A higher-confidence pair keeps priority over any combination of lower-confidence pairs; the planner does not optimize the sum of scores.
- Treat product-scoped direct price metadata and visible product price as stronger than contradictory JSON-LD. Reject the contradictory structured signal and record a machine-readable conflict attribute.
- A published price comparison requires finite positive observed prices on both sides, supported currencies, source URLs, observation timestamps, and exact currency equality. No silent FX conversion.
- `publishPricedProductComparison` is the server-side constructor for `publication.priceEligible`. Persistence, pagination, evaluation, and rendering consume that server-generated invariant; direct mutation of trusted database rows is outside the public-input threat boundary.
- A company may remain a market competitor when first-party evidence shows it serves that market, while incompatible-currency product offers are excluded from the price-comparison table.
- Country, locale, currency-query, and country-TLD context is part of product identity. Enrichment, GTIN deduplication, redirects, storefront adapters, and final reconciliation cannot move a price across those contexts.
- Generic itemprop metadata and related-product cards are not authoritative main-product price evidence. List, original, RRP, retail, member, expired, incomplete, and reversed-range offers fail closed.
- Existing reports created before the publication gate do not have a trusted `publication.priceEligible` decision. They intentionally fail closed and may show no price-comparison rows until rerun; the release must surface this as a legacy data-quality state rather than implying that the old rows were revalidated.

Early Fable 5 startup attempts returned `unrecognized_model` / inaccessible-model errors on 2026-08-16, so independent Codex fallback reviewers identified blockers in the earlier drafts. A later interactive session was explicitly verified in the Claude UI as Fable 5 with high effort and became the final merge gate. The final draft clears conflicting fresh price evidence instead of restoring stale values, keeps metadata amount/currency pairs inside one provenance namespace, gives coherent product-scoped metadata priority over generic Open Graph fallbacks, reconciles compatible point/range evidence across direct, visible, structured, and storefront-adapter sources, prevents a fallback adapter from overwriting coherent canonical-page evidence, retains distinct product identities that share one catalog URL, globally ranks atomic pair-enrichment work under the page cap, preserves excluded semantic matches with an explicit publication reason, requires Medium match confidence for publication, prevents excluded pairs from receiving accepted evaluation priority, validates source URLs and timestamps, filters excluded records from the public price table, reports authoritative persisted match totals instead of compact-snapshot counts, and prevents report transitions from reusing another report's rows or totals.

## Validation

- Focused price, planner, storefront, provenance, and compaction regressions passed.
- Earlier full validation passed 850 tests before the latest reviewer round.
- A strict fallback review of head `309ad94504c9029a8efc4a365daeed423c1cd2c2` found two release blockers: query-selected regional catalogs could merge, and repeated list/current metadata could be presented as a range. Both now fail closed with focused regressions; a fresh exact-head review is required.
- Two strict fallback reviews of head `22d1c73b8af96557567e9287f6a9e5571f3f7152` found collection sibling contamination, country-path and generic-ccTLD classification gaps, nested sale/list specifications, an unscoped Shopify query-market amount, and non-country region grouping errors. Each reproduction now fails closed; another fresh exact-head review is required.
- Two strict fallback reviews of head `35e09c5b83feb7173d881a30cbdbdc8f2c34ced5` found selector-precedence and conflict gaps, market-losing redirects, regional storefront API leakage, cross-market GTIN merging, list/range fabrication, related-carousel leakage, and stale saved prices. The current draft adds complete ISO-country recognition with conservative ambiguous-language handling, explicit-selector precedence and conflict rejection, redirect market continuity, regional Shopify/WooCommerce safeguards, market-aware GTIN identity, current-offer-only structured extraction, textual related-product boundaries, and stale-price sanitization. Fresh exact-head reviews are required.
- A strict fallback review of head `bf3bf49a558a53ff8e1b4c9ace94f2cf321e6292` found report-creation-time freshness skew, nested regional-path escapes, additional recommendation headings, expired offers, and embedded amount/currency contradictions. Focused reproductions now pass; a fresh committed exact-head review is required.
- Two strict fallback reviews of head `cc68ea33b4b94d513c1a8eeb1ffbeff20ede5af0` found live Arklavo GBP/USD metadata conflict leakage, currency-query adapter stripping, related-card itemprop contamination, cross-currency GTIN and final-enrichment merging, contradictory path selectors, unscoped regional WooCommerce leakage, TLD redirect switching, non-current offer labels, and reversed ranges. The current draft adds exact-H1 metadata binding, currency-aware identity and adapter URLs, complete pre-route conflict collection, market-safe reconciliation, additional related-section boundaries, and current-offer/range validation.
- Verified Claude Fable 5 strictly reviewed head `69bf69cc464ea99e2ce921b99ca228c54480a81f` and returned FAIL. It reproduced schema.org `ListPrice`/`RegularPrice`/member-style enum leakage and a fabricated range from a collapsed range plus an unrelated point. The current draft tokenizes machine labels before classification, rejects the additional non-current enum families, and requires the two published range signals to be the endpoints of an actual non-degenerate range. Fable also requested an explicit product decision for pre-gate legacy reports; that fail-closed limitation is now documented and must be user-visible.
- Verified Claude Fable 5 strictly reviewed head `1ce0bf816908a240e01eda11e2a7f39b5c8a22e3` and returned FAIL. The extraction blockers were fixed, but the first legacy-report detector also counted fresh unmatched-competitor placeholders and could falsely label a new report as legacy. The detector now counts only actual `product` or `excludedProduct` decisions that lack a boolean publication gate, with behavioral tests for both fresh placeholders and legacy decided pairs.
- Full `npm test`: 862 tests passed after these fixes, including type checks and the production build.
- `npm run lint`: 0 errors and 2 pre-existing `<img>` performance warnings.
- Exact-head verified Fable 5 re-review and production deployment remain pending.

## Acceptance criteria

- Under a tight page budget, missing prices that complete accepted pairs are selected before image-only targets.
- A product page with direct `GBP 100` metadata and contradictory `USD 12000` JSON-LD cannot produce the USD price.
- Missing-primary, missing-rival, and cross-currency pairs are not counted or displayed as published price comparisons, and suppression reasons are persisted.
- Existing same-currency, fully priced comparisons continue to publish.
- Focused tests, full test/build/lint, and real public Wearform and Arklavo probes pass.
- A fresh Wearform production report contains no published price row with a missing side or mismatched currencies.

## Data boundaries

All prices remain public observations with source URLs and observation timestamps. No exchange-rate conversion or inferred market currency is introduced. Semantic matches excluded from the price table remain available only as non-price evidence where the report schema supports that distinction.
