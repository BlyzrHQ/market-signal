# Task 121 — Persisted human-review queue

## Objective

Turn an agent evaluation's bounded `humanReview` request into an immutable,
owner-only queue item and persist one immutable owner response without changing
the model output, evaluation status, or provisional deterministic-only rating.

## Scope

- Create an immutable `report_human_review_requests` row atomically with a
  successful `needs_human_review` terminal callback.
- Persist one immutable `report_human_review_responses` row per request.
- Keep a disposable `report_human_review_open` pointer for bounded owner polling;
  answering removes the pointer but never deletes the audit records.
- Add a separately authenticated owner API that lists a bounded, keyset-paged
  queue and accepts an idempotent response.
- Return the report domain, private report URL identifier, bounded agent
  strengths/weaknesses/proposals, the exact human question, its uncertainty
  code, and cited evidence IDs. Never return model prompts, raw HTML,
  credentials, reservation metadata, or the customer access token separately.
- Purge requests and responses with their source report before evaluations are
  removed.

## Contract and invariants

1. A request is created only when the validated terminal result is persisted as
   `needs_human_review`; its question, uncertainty code, evidence IDs, evaluation
   ID, run ID, and creation time are immutable.
2. The request insertion and evaluation terminal transition use one database
   batch. A unique `evaluation_id` prevents duplicate requests.
3. An owner response uses `answered`, `unable_to_determine`, or
   `invalid_question`, bounded answer text, and a caller-generated idempotency
   key. The first response is
   immutable; an exact replay returns the existing row and a different replay
   returns HTTP 409.
4. Human input never rewrites `agent_json`, scores, grade, findings, proposals,
   `rating_basis`, or evaluation status. It is a calibration label for later
   work, not a retroactive model answer.
5. Owner routes require separate server-only
   `MARKET_SIGNAL_OWNER_READ_TOKEN` and `MARKET_SIGNAL_OWNER_WRITE_TOKEN`
   values of at least 32 non-whitespace characters. They must differ from each
   other and from the Trigger callback token or access fails closed. Responses
   are `Cache-Control: no-store`.
6. Queue reads are ordered by a server-generated monotonic `queue_seq`, limited
   to 50, and use an opaque bounded cursor. A disposable open pointer makes
   reads bounded; decisions delete only that pointer while the immutable audit
   records remain. Expired reports are excluded.
7. Questions, notes, and JSON bodies have explicit byte/character limits;
   unknown keys and malformed enums fail closed.
8. Retention deletes responses, then requests, before deleting evaluations.

## Acceptance criteria

1. Valid human-review callbacks atomically persist exactly one request; invalid,
   rejected, non-human, or conflicting callbacks persist none.
2. Auth separation, pagination, bounded open-queue work, logical expiry, input
   bounds, exact replay, conflicting replay, and immutable-response behavior are
   covered by tests.
3. Runtime SQLite schema, Drizzle schema, generated migration, retention audit,
   deployment examples, and VPS typecheck/build contracts include both tables.
4. Existing report evaluation at-most-once and cost tests continue to pass.
5. A private production smoke proves the queue endpoint is authenticated and
   the exact approved revision is live. A real human request is optional until
   Task 122 runs the controlled public-domain pilot.

## Review record

- Fable 5 attempt on 2026-08-09 returned the observable usage error:
  `You've hit your session limit · resets 6:40am (Africa/Cairo)`.
- This is a high-risk data/authentication change, so the AGENTS.md fallback
  requires two fresh independent Codex reviewers and both must report no
  blockers before merge.

## Out of scope

- Public/customer display of internal evaluations.
- Automatically changing prompts, crawler policy, scores, or production code.
- Delivering queue items into the current Codex task; Task 122 owns that monitor
  and feedback inbox.
