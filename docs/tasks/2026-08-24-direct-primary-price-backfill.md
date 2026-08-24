# Direct-search primary-price backfill

## Problem

After the direct-search checkpoint fix, a production Starter report for `noororganicfood.com` crawled 250 primary products but published only seven priced comparisons. Read-only production inspection showed only 20 of the 250 primary products had a usable price: four arrived priced from catalog discovery and the fixed pre-search enrichment ceiling fetched only 16 more. Direct search correctly skips price-less primary products, so it exhausted those 20 eligible products before reaching the 20-comparison entitlement.

- Report: `af01f6a7132c4a2d97f352376b4422ce`
- Trigger run: `run_06g3a3caakkca8he5umlpq2r01`
- Deployed revision: `c09f306fb4417eef581698ad8f447f15d0de68ec`
- Trigger version: `20260824.4`
- Result: 7 priced comparisons from 20 searches; 250 primary catalog products, only 20 priced

## Change

- Preserve the existing 16-page price-enrichment ceiling for legacy competitor-discovery reports.
- For direct-product-search reports, use the existing storefront enrichment request ceiling of 64 primary pages.
- Keep primary page identity, robots, source-domain, positive-price, supported-currency, and no-empty-price validation unchanged.

This widens scripted public-page price collection before paid search. It does not add AI calls or weaken publication requirements.

## Acceptance

- A regression test proves the explicit 64-page direct-search budget enriches exactly 64 of more than 64 eligible primary products.
- Existing default enrichment remains capped at 16.
- Full typecheck, build, lint, and tests pass.
- Review follows the repository gate; deployment uses Trigger before the exact merged VPS revision.
- A fresh Noor Starter report publishes 20 price-eligible comparisons before the remaining domain sequence resumes.

## Spend guard

The complete five-report exercise remains under the user-authorized USD 20 ceiling. Reports run sequentially and stop on the first failure. This backfill uses ordinary bounded HTTP fetching; another paid report is not launched until the fix is reviewed and deployed.

## Data boundaries

Only same-domain public product pages selected from the crawled catalog are fetched. Empty, zero, malformed, stale, unsupported-currency, cross-domain, and identity-mismatched prices remain excluded.

## Review record

- A verified `claude-fable-5` review was attempted read-only against the exact working diff on 2026-08-24.
- At `2026-08-24T18:49:20.6176402Z`, the Claude CLI returned the observable capacity category `budget_exhausted` with the exact non-sensitive message `Error: Exceeded USD budget (2)` before producing a verdict.
- Per `AGENTS.md`, the review gate therefore used fresh Codex fallback reviewers; no Fable approval is claimed.
- The first fallback review found a P1 blocker: execution raised the direct-search budget to 64 while coverage-document and endpoint metadata still advertised 16.
- The implementation now derives coverage metadata from the effective enrichment result and both endpoint responses from the direct-search policy. Route-level regression assertions cover direct-search 64 and legacy 16 metadata.
- After the correction and a complete validation rerun, a fresh fallback reviewer returned `PASS — no blockers`.

## Validation

- Focused crawl, storefront-enrichment, and matching checks: 144 passed, 0 failed.
- Full `npm test`: 1,198 passed, 0 failed. This includes both TypeScript checks and the production build.
- `npm run lint`: 0 errors; one pre-existing unrelated `@next/next/no-img-element` warning in `app/components/product-design-lab.tsx`.
