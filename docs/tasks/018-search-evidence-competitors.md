# Task 018 — Search-evidence competitor recovery

## Problem

The real MyJam crawl found 404 catalog products and generated seven product-specific UK searches, but the AI returned an empty structured candidate array. Market Signal incorrectly converted that model abstention into a zero-competitor report even though public search exposed directly comparable seller product pages.

## Goal

Treat directly cited seller product pages as deterministic discovery evidence. AI may summarize and rank candidates, but it must not be the only gate capable of erasing observed search results.

## Method

1. Read the Responses API web-search source list and URL citations already requested from the official API.
2. Match source titles and URL paths against the crawled primary product catalog using conservative multi-token overlap.
3. Exclude the primary domain, social networks, publishers, and weak one-word matches.
4. Crawl every accepted seller page and retain the existing independent product and region verification gate.
5. Ignore tracking query parameters when verifying that the cited product page was fetched.

## Acceptance

- An empty AI candidate array cannot hide directly observed, product-matching seller sources.
- Candidates still require a fetched product page, a defensible product pair, and a same-region signal before appearing as competitors.
- Search-source evidence records the direct URL, matched primary product, query, method, and reason.
- MyJam returns at least one real, product-verified UK competitor in production.
- No directories, social profiles, publishers, fixtures, or invented competitors are presented as live results.
- Tests, lint, build, strict Fable review, PR, merge, deployment, and live MyJam verification pass.

## Review outcome

Fable 5 completed two strict read-only reviews. The first returned `PASS` but required primary-subdomain exclusion and an integration test for the exact empty-model-candidates regression before merge. Those changes were implemented together with tracking-only URL normalization, obvious recipe/article rejection, and source recovery when structured output is missing. The second review independently ran all 46 tests and returned `FABLE_GATE: PASS` with no blockers.

## Validation so far

- Baseline production MyJam run: 404 real products crawled, seven product-specific UK searches generated, zero candidates returned because the structured AI candidate array was empty.
- `npm test`: 46/46 passing, including the exact empty-candidate/source-present regression.
- `npm run lint`: passing.
- Focused crawl and discovery TypeScript check: passing.
- Live post-deployment MyJam verification remains required before merge.
