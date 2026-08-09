# Task 122 — Durable evaluation feedback outbox

## Objective

Persist every terminal report-evaluation event in an owner-only, bounded,
at-least-once delivery queue. A consumer claims one event briefly, presents its
sanitized good/bad/fix breakdown, and acknowledges that exact payload only
after presentation succeeds.

## Scope

- Create one immutable outbox event for every report evaluation that enters a
  terminal state, including deterministic failures, dispatch exhaustion,
  provider outcomes, and watchdog recovery.
- Create the event in the same SQLite transaction as the terminal transition.
  A unique evaluation ID prevents duplicate events and an insertion failure
  rolls back the terminal transition.
- Keep terminal evaluations and outbox events database-immutable.
- Add dedicated monitor read and acknowledgement credentials that are distinct
  from callback and owner credentials.
- Add a bounded claim API. Claims are short, renewable only after expiry, and
  never hold a database transaction while a consumer processes feedback.
- Add an immutable acknowledgement receipt. Exact replay succeeds; a changed
  delivery, lease, payload hash, consumer, or idempotency key conflicts.
- Purge claims, receipts, and outbox events before their source evaluations.

## Delivery truth

- Delivery is **at least once**. A consumer crash after presentation but before
  acknowledgement can produce a recognizable duplicate.
- Every presentation includes the stable delivery ID.
- One automation run claims and renders at most three items and acknowledges
  each item separately only after it is presented.
- A failed presentation is not acknowledged. The lease expires and the oldest
  unacknowledged item becomes eligible again.
- Feedback acknowledgement means “surfaced to the owner”, not “human question
  answered”. Task 121's human-review request remains open independently.

## Sanitized owner contract

Return only the delivery/evaluation/request identifiers, public report
identifier, domain, terminal status and bounded error category, model-labelled
strengths/weaknesses/proposals, exact optional human question and evidence IDs,
bounded scores, known usage cost, completion time, stable payload hash, lease,
and backlog count/age. Do not return prompts, provider/reservation metadata,
raw evidence or HTML, credentials, customer access tokens, or model input.

## Rollout boundary

This task does not enable global agent evaluation and does not create the Codex
automation. Task 123 owns the restricted SSH principal/helper, monitor,
end-to-end public-domain pilot, backlog/cost checks, and separately verified
enable/rollback deployment.

## Acceptance criteria

1. Insert/update terminal paths produce exactly one outbox event atomically.
2. Injected outbox failure rolls back the terminal evaluation transition.
3. Claim races have one winner; expired claims can be recovered.
4. ACK exact replay succeeds and changed replay returns a conflict.
5. Expired reports cannot be claimed or acknowledged.
6. Queue work, response size, leases, and backlog metadata are bounded.
7. Retention removes all feedback artifacts and records exact anonymous counts.
8. Existing tests, typecheck, build, VPS build, and lint remain green.

## Review record

- Fable attempt returned: `You've hit your limit · resets 6:40am
  (Africa/Cairo)`.
- Two fresh Codex architecture reviewers rejected a non-durable polling design
  and required atomic terminal coverage, stable delivery IDs, explicit
  at-least-once semantics, immutable ACK receipts, short claims, dedicated
  credentials, bounded backlog visibility, and a restricted monitor in the
  follow-up task. This contract incorporates those requirements.
