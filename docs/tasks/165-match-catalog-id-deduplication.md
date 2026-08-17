# Task 165 — Match catalog ID deduplication

## Problem

A live 20-product MyJam report reached product matching with valid crawled catalogs, but both match requests returned HTTP 400 before any AI work. Production access logs showed the same response signature as the route's missing-primary-catalog validation. The persisted catalog parsed successfully because storage had already deduplicated its records; the raw crawl payload contained repeated product IDs, and the match boundary invalidated every catalog when it encountered any repetition.

## Change

- Deduplicate repeated product IDs when they belong to the same canonical domain and public source URL.
- Drop only the ambiguous ID when the same domain submits that ID for conflicting source URLs.
- Continue rejecting the entire request when a caller-controlled ID crosses canonical domain boundaries or catalog domains collide.
- Set every new hosted plan to the same 20 assessed products per report; plan tiers now differ by monthly report allowance rather than expanding one report's assessed set.
- Preserve old reports' persisted product limits and accept already-dispatched version 3 worker payloads so the change does not rewrite history or strand in-flight work.

## Validation

- Route regressions cover harmless duplicate records, conflicting same-domain records, cross-domain collisions, pin validation, and existing catalog bounds.
- Run focused route/matcher tests, full tests, lint, and the VPS build.
- Obtain strict exact-head Fable 5 review before merge.
- Deploy Trigger before the exact approved VPS commit and run one fresh live MyJam report. Completion requires 20 assessed primary products, at least one verified comparison, and no published rival comparison without a finite positive supported-currency price.

## Data boundaries

This changes normalization of authenticated internal crawl output only. It does not manufacture products, prices, or competitors. Conflicting identities still fail closed at the record level, and public evidence requirements remain unchanged.
