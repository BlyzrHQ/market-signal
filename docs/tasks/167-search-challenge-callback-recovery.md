# Search challenge callback recovery

## Problem

The first production search challenger completed its paid provider request, but
the application rejected the terminal callback with HTTP 400. The evaluation
remained `reserved`, so its result, usage state, and feedback were not visible.

## Scope

- Return bounded machine-readable worker API errors without exposing callback
  bodies or credentials.
- Normalize the callback payload and retry a schema-rejected terminal callback
  once as a cost-preserving terminal failure.
- Reconcile stale reservations into `call_outcome_unknown` through the existing
  watchdog/outbox path.
- Version the corrected challenger and allow scoped recovery to create and
  dispatch the corrected challenge for an existing terminal report.
- Preserve the USD 0.10 UTC-day budget gate; an unknown prior call closes that
  day's budget.

## Validation

- Focused callback, store, and recovery-route regression tests.
- Full test, lint, VPS build, and diff checks.
- Strict exact-head reviewer approval before merge.
- Trigger deployment before the exact VPS commit, followed by live health and
  saved-report challenger verification after the UTC budget permits it.

## Data boundaries

The challenger remains an independent post-report evaluation. It does not
modify customer-visible report facts. Candidate pages still require the same
first-party, identity, market, supported-currency, and positive-price checks.
