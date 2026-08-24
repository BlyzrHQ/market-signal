# Direct-search rival capacity alignment

## Problem

The Beardbrand Starter acceptance report collected twenty priced primary/rival
pairs, but two pairs referenced the same canonical rival product page. The
global publication assignment correctly counted that rival product once, so the
customer-visible report contained nineteen comparisons even though direct
search stopped at its raw target of twenty.

## Goal

Make direct product search count the same globally unique rival components as
the publication assignment. A duplicate rival component must not consume the
requested comparison target; direct search must continue through the bounded
primary pool for another priced result.

## Scope

- Share the publication rival-constraint identity with direct search.
- Skip a priced direct-search outcome when any of its durable rival constraints
  were already selected for another primary product.
- Preserve multiple distinct rival products for the same primary product.
- Preserve the no-empty-price and safe-public-HTTPS source requirements.

## Acceptance criteria

- A repeated canonical rival URL across two primary products counts once.
- Direct search continues to a later primary product and fills the target with
  a distinct priced rival when one is available.
- The pair-target publication step retains the full direct-search target.
- Relevant tests, full tests, and lint pass.
- The exact reviewed commit is deployed to Trigger and the VPS.
- A fresh Beardbrand Starter report publishes exactly twenty priced
  comparisons before a fifth-domain report is launched.

## Validation and review

- Run focused direct-search and product-match lifecycle tests.
- Run the full test suite and lint.
- Request a strict Fable 5 review. If Fable returns an observable capacity or
  budget error, record it and use the repository's Codex fallback review gate.
- Keep the five-report rollout under the user-approved USD 20 total ceiling.
