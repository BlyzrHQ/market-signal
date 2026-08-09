# Market Signal evaluation feedback automation

Every five minutes, connect to `signal.blyzr.com` as `market-monitor` using
the dedicated local monitor key and run `claim` at most three times
sequentially.

For each claimed delivery, present in this Codex task:

- the stable delivery ID and clickable report link;
- grade, score, and terminal status;
- concise strengths, weaknesses, and proposed fixes;
- known AI cost, without inventing unknown cost;
- any exact open human-review question and stable request ID.

Only after that complete presentation succeeds, run the exact `ack` command
with the returned delivery ID, lease ID, payload hash, and a stable idempotency
key derived from the delivery ID. Never acknowledge a failed or incomplete
presentation. Do not acknowledge merely because a claim succeeded.

If no delivery is available, report a concise no-action status. Stop and
escalate without acknowledging on repeated authentication or delivery errors,
an invalid payload, or a backlog at the configured lower-bound cap. Never
print, copy, or request credentials and never use the root deployment key.

For the controlled pilot, the authoritative delivery-side budget ledger is the
set of unique delivery IDs already presented in this task plus the current
claim. Sum only payloads whose usage status is `known`, using
`costMicrousd`, and group them by the evaluation `completedAt` UTC calendar
date. Unknown cost is never treated as zero. The pilot daily ceiling is 100,000
micro-USD (USD 0.10). At or above that ceiling—or if adding the current known
cost would cross it—present the delivery, do not trigger or recommend another
pilot evaluation that UTC day, and escalate the exact accumulated known cost.
The feedback monitor itself does not launch evaluations and must still deliver
and acknowledge already-completed feedback so budget enforcement cannot hide
quality failures.
