# Direct-search first-party page signals

## Problem

The production Wearform Starter acceptance report completed with only two of 20 required priced comparisons.

- Report: `e17e7a08d46940248ac7b65341de7a0c`
- Trigger run: `run_06g3ae440fkr9uetsj1prsuo01`
- Revision: `386df35d8421b8e5b9207481db700cf8ce92c2a5`
- Trigger version: `20260824.5`
- Result: 755 first-party catalog records, but direct search processed one primary record and published 2 price-eligible comparisons

Read-only production evidence showed Wearform's valid first-party product pages were extracted as priced `PageSignal` records. The direct matcher admitted only primary records typed `Product`, so it discarded 754 of 755 catalog records before the no-empty-price gate and had only one searchable primary.

## Change

- Admit first-party primary records typed either `Product` or `PageSignal` into direct product search.
- Preserve the existing positive, supported, observed-price requirement before any paid search begins.
- Preserve HTTPS source, catalog bounds, durable checkpoints, result targets, search count, and work-time limits.

This is the same bounded record-type policy already used for durable priced rival outcomes. It does not admit empty-price records or add a new search path.

## Acceptance

- Regression coverage proves a priced first-party `PageSignal` is searched and can publish a price-eligible result.
- Existing tests continue to prove unpriced primary records never spend a search.
- Full typecheck, build, lint, and tests pass.
- Review follows the repository gate, followed by Trigger-first and exact-revision VPS deployment.
- A fresh Wearform Starter report publishes exactly 20 price-eligible comparisons before the remaining domain sequence resumes.

## Spend guard

The five-report exercise remains below the user-authorized USD 20 ceiling. Reports are sequential and stop on failure. Only the 20-comparison Starter plan is used.

## Data boundaries

Only already-crawled first-party records with public HTTPS source evidence and a finite positive supported-currency price are eligible. Empty, zero, stale, unsupported-currency, or unsafe records remain excluded before search.

## Review record

- A verified `claude-fable-5` review was attempted read-only against the exact working diff on 2026-08-24.
- At `2026-08-24T19:32:07.9916179Z`, the Claude CLI returned the observable category `budget_exhausted` with the exact non-sensitive message `Error: Exceeded USD budget (2)` before producing a verdict.
- Per `AGENTS.md`, the review gate therefore used fresh Codex fallback reviewers; no Fable approval is claimed.
- The first fallback review found that an HTTP primary source could still spend paid search. The implementation now requires a non-empty canonical public HTTPS product URL before checkpoint loading or search.
- A fresh re-review found that skipped unsafe primaries still counted as eligible and could trigger needless retries. Search admission and eligibility counting now use the same priced-plus-canonical-HTTPS predicate; regression coverage proves zero checkpoint reads/writes and terminal exhaustion for an HTTP `PageSignal`.
- After both corrections and a complete validation rerun, a final fresh fallback reviewer returned `PASS — no blockers`.

## Validation

- Focused direct-search and match-route checks after the HTTPS correction: 40 passed, 0 failed.
- Full `npm test` after the HTTPS correction: 1,200 passed, 0 failed. This includes both TypeScript checks and the production build.
- `npm run lint`: 0 errors; one pre-existing unrelated `@next/next/no-img-element` warning in `app/components/product-design-lab.tsx`.
