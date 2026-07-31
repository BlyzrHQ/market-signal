# Task 089 — Expired report retention

## Outcome

Delete expired, inactive report evidence before model-backed report evaluation is enabled. Retention must be bounded, atomic, observable without customer identifiers, and compatible with older report workers.

## Scope

- Advertise `report.retention.purge` without changing worker protocol version 1 or its legacy required capability set.
- Add an authenticated internal purge endpoint that accepts only `purge-expired` and computes its own cutoff.
- Delete at most 25 reports per atomic pass when `expires_at <= now` and `heartbeat_at <= now - 24h`.
- Delete all dependent report rows in the approved order, then the report run.
- Keep count-only purge audits for 365 days; never record report IDs, public IDs, or domains.
- Run a Trigger scheduled task daily at 03:17 UTC, concurrency one, at most 40 passes per run.

## Excluded

- Model-backed judging and pending-evaluation recovery.
- Read-route `410 Gone`, user account deletion/export, vacuuming, owner UI, and evaluator calibration.
- Purging verified competitor memory.

## Acceptance

- Exact cutoff and heartbeat boundary behavior is tested.
- Every report artifact table is deleted with exact audit counts.
- Fresh and recently heartbeated expired reports remain intact.
- A real SQLite failure rolls the entire pass back.
- Replays and concurrent passes are safe.
- Internal auth, body bounds, unknown actions, capability compatibility, cron, concurrency, pass cap, and logging are tested.
- Full typecheck, production build, tests, and lint pass.
- Strict Fable 5 review passes before merge.
- Deploy VPS application first, then Trigger; manually verify a zero-backlog production pass.

## Review record

- Fable 5 architecture gate: `TASK_089_SCOPE_PASS`.
- Final code review and deployment evidence will be recorded in PR #89.
