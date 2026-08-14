# Task 130 — Bounded report-evaluation recovery

## Problem

The Wearform report received the deterministic quality profile, but the paid
agent judge was correctly not dispatched because the production evaluation
pilot was disabled. The existing recovery route cannot safely recover one
report: global mode selects up to 25 historical candidates and could release
an unbounded paid backlog.

## Decision

- Keep automatic agent evaluation fail closed. Do not enable every public
  report until account abuse controls and an atomic aggregate daily cost budget
  exist.
- Make manual recovery an authenticated, exact operation accepting one to
  three unique 32-character public report IDs.
- Preserve the scheduled empty-body recovery call as watchdog-only
  reconciliation; it may repair stale state but cannot dispatch paid backlog.
- Authenticate before reading or parsing the bounded request body.
- Reconcile watchdog states, then query only evaluations belonging to the
  requested reports. Never enumerate the unrelated historical backlog.
- Preserve the existing atomic dispatch claim, attempt binding, Trigger
  idempotency key, reservation contract, and ambiguous-outcome terminal state.
- Use this route to recover Wearform report
  `b5911b3bf1b24d17bf850e43c5c2fb8d` after deployment.

## Review boundary

Fable 5 timed out during the architecture review. The user-authorized Codex
review fallback returned **BLOCK** on global automatic rollout because public
report creation currently lacks aggregate spend and abuse controls. It approved
the exact authenticated recovery as the smallest safe alternative. Fable 5
remains the required merge gate under `AGENTS.md`.

## Acceptance criteria

1. Missing, malformed, duplicate, oversized, or more-than-three report IDs fail
   before reconciliation or dispatch.
2. Authentication happens before request parsing.
3. Recovery queries and dispatches only eligible evaluations for requested
   public report IDs.
4. Watchdog reconciliation remains active and ambiguous model outcomes are not
   retried.
5. Focused tests, full tests/build/typechecks, lint, and a strict Fable 5 review
   pass before merge.
6. The exact merged commit is deployed and the Wearform evaluation produces a
   durable feedback delivery.
