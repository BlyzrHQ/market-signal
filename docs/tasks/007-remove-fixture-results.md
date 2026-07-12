# Task 007 — Remove fixture results from the customer-facing report

## Goal

Make the demo truthful: customer-facing content must come from the public
domains the user submits or be labeled as an uncollected coverage state.

## Changes

- Removed named fake competitors, product/pricing rows, ad counts and spend
  ranges, fake market scores, fake timestamps, and the fake default domain.
- Replaced the hero chart with the actual collection method.
- Replaced market-score language with observed source-surface counts.
- Added explicit coverage states for pricing pages, ad libraries, and history.
- Kept comparison cards and pricing tables only for domains fetched in the
  current run.

## Acceptance criteria

- No fixture names or result values appear in rendered product source.
- Pre-scan UI shows no market facts; it shows an empty state or em dash.
- Live values are derived from `/api/analyze` results.
- Uncollected sources are visible as gaps, never as zero or estimated facts.
- Build, lint, rendered tests, and a real public-domain scan pass.

## Review record

Explicit Sonnet 5 review found no blockers. It confirmed that fixture arrays and
the default domain are gone, live values are sourced from fetched domains, and
coverage gaps are explicit. It noted only orphaned unused CSS as cleanup debt.
