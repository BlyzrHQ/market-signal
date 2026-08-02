# Task 094: Streamline report navigation

## Request

Remove the Ads and Evidence & Method tabs, make Benchmark the final tab, and remove the customer-facing Product Data Gap panel from product comparisons.

## Decision

- Show exactly three report tabs in this order: Competitors, Products, Benchmark.
- Make Competitors the default for complete reports because it is the first and primary market-intelligence view.
- Keep Benchmark as the sole view for parked or unavailable domains.
- Canonicalize missing, unknown, Ads, Evidence, and Methodology view parameters to the applicable first view with `replaceState`, removing stale hashes.
- Remove all customer links into hidden Ads or Evidence views.
- Preserve ads, evidence, gaps, and enrichment diagnostics in saved report data and APIs. This task changes presentation only.
- Remove the yellow Product Data Gap panel while retaining the underlying enrichment-gap records.

## Acceptance criteria

- Desktop and compact navigation show Competitors, Products, Benchmark in that order in English and Arabic.
- Bare complete-report URLs land on Competitors and become `?view=competitors`.
- Legacy hidden-view URLs resolve to Competitors without a back-button bounce or stale hash.
- Product and Benchmark deep links continue to work.
- Parked or unavailable reports show only Benchmark.
- No rendered report link targets Ads or Evidence.
- Product pages do not render Product Data Gap or its selected-page failure rows.
- Saved report/API structures are unchanged.
- Keyboard tab navigation continues to cycle through only the visible tabs.

## Fable decision

Verified Fable 5 selected Competitors as the default, approved UI-only hiding of Ads/Evidence data, required stale links and hashes to be removed, and kept Benchmark as the sole terminal-domain view.
