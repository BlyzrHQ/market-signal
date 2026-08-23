# Product-search durability and cost circuit breaker

## Problem

The production MyJam Starter proof at report
`eebc862983214fe88ac4d259cffc9d66` collected 1,000 primary products but
published zero priced comparisons. Product discovery searched zero completed
anchors, sent no candidates to matching, and retried the same ten paid search
lanes across ten task attempts.

The report contract is comparison-first:

- Starter targets 20 accepted, source-linked, same-market priced product pairs.
- One primary product may contribute several pairs against distinct rival
  products or sellers.
- Rival companies are not a separate quota. The report derives and deduplicates
  competitor domains only from the final selected comparison pairs.

## Root cause

Discovery currently treats a completed web-search tool call as failed when its
optional structured summary is missing or malformed, discarding attributable
search sources. It also checkpoints only a batch cursor. Any genuinely failed
lane keeps that cursor at the start of the ten-lane wave, so every retry buys
all ten searches again and loses candidates from completed lanes.

Fable 5 reviewed the failure evidence and returned `NEEDS-WORK`. Its required
repair is per-anchor durability, a bounded sanitized failure taxonomy, reuse of
already-paid search leads, and a fail-fast circuit for systemic provider
failure. Truth, market, product-identity, and price gates must remain unchanged.

## Scope

1. Treat a completed web-search call as completed search evidence even when the
   model's structured summary is unavailable; recover attributable candidates
   from provider source URLs.
2. Return a bounded, private per-anchor product-search ledger from the internal
   crawl endpoint and persist it in the existing crawl checkpoint.
3. On task retry, reuse completed lanes and rerun only missing/failed anchors,
   with at most one paid retry per failed anchor.
4. Advance past a terminal mixed-failure wave without claiming complete search
   coverage, and stop the report early when an entire fresh wave fails with one
   systemic provider category.
5. Surface only bounded failure categories and fixed public messages. Never
   expose provider response bodies, credentials, or raw thrown messages.
6. Preserve the comparison-first publication contract and derive competitor
   domains only from selected accepted pairs.

## Acceptance criteria

- A prior ledger with nine completed anchors causes exactly one paid fetch for
  the missing tenth anchor; completed candidates are reused.
- A second failure of the same anchor is terminal for that wave and is not paid
  for again.
- Ten same-category fresh failures open the provider circuit and prevent the
  remaining Trigger retries from replaying the wave.
- HTTP, timeout, unreadable, network, and incomplete-search failures have a
  bounded category; provider bodies and raw exception messages do not appear in
  customer-visible output.
- A completed web-search tool call with malformed structured output can still
  yield deterministic source-backed candidates and does not force a paid retry.
- The existing 20-pair selection, market, identity, and supported-price tests
  remain green; competitor domains equal the deduplicated domains represented
  in those selected pairs.
- Build, lint, type checks, and the full test suite pass.

## Cost boundary

No additional live MyJam report or paid evaluation is part of this task. The
user will run the post-deployment acceptance report. Validation uses fixtures
and mocked provider responses only.

## Implementation and validation

- Completed provider source URLs now survive an unavailable structured summary.
- A private, bounded per-anchor ledger is persisted through the crawl checkpoint;
  invalid ledgers stop before any paid replay.
- Completed anchors are reused, failed anchors receive at most one paid retry,
  and a same-category full-wave failure opens the usage-protection circuit.
- The 20-pair selection and downstream competitor-domain derivation are unchanged.
- `npm.cmd test`: PASS (build, browser and Node type checks, 1,118 tests).
- `npm.cmd run lint`: PASS with two pre-existing `no-img-element` warnings.
- No live report, evaluation, or provider request was launched during validation.
