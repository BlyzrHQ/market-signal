# Direct Trigger workflow parity

## Request
Make the internal CLI execute the website's complete report workflow inside the
operator's Trigger environment. Keep the website unchanged; do not call the VPS
or require customer login/entitlements. Branch: `codex/trigger-workflow-parity`,
based on draft PR #226 (`266d818`).

## Findings
The former direct task used one bounded search pass, an early seller cap, and a
quality gate with its repair budget already exhausted. It omitted the website
engine's durable continuation, final price enrichment, repair, AI action plans,
and rival experience benchmark. A successful deterministic gate is not proof of
semantic product equivalence.

## Implementation and acceptance
- Reuse the actual report orchestration engine with a Trigger-native port.
- Preserve the website's authorization and plan-validation entry points.
- Persist checkpoints and authoritative facts in Trigger-owned durable storage;
  local memory/disk alone is not a retry mechanism.
- Keep prices, public sources, evidence classifications, limitations, and
  unknown cost explicit in the agent-readable output.
- Validate resume/integrity/failure cases locally before a bounded live test.
- Deploy an unpromoted worker version only. No broad paid test batch, VPS
  deployment, or promotion of website tasks.

## Status
In progress. Claude Fable 5.1 (`claude-fable-5-1`) reviewed the architecture:
reuse the core, retain website guards, use Trigger-owned snapshots with flushed
metadata, separate child queue, CAS checkpoints, and full facts. Codex verified
SDK child waits automatically pin to the parent's version. We use one bounded
compressed snapshot pointer rather than a large metadata index; this trades
additional snapshot storage for a small constant-size metadata record and one
read on recovery. Snapshot limits and uncertain-response stop behavior are
explicit. No strict code PASS or deployment is claimed yet.

Initial local checks: 8 native adapter/state tests pass, full Node suite passes,
Go tests/vet pass, standalone Trigger TypeScript check passes, and the website
build passes. Lint has no errors and one pre-existing image warning. Trigger
bundle validation and strict code review remain pending.

## Review fallback and deployment checkpoint
At 2026-09-04T23:51:50Z the strict Fable review command exited 1 with the
observable platform response: `You've hit your session limit · resets 4am
(Africa/Cairo)`. Category: session usage limit. The Fable architecture review
above succeeded, but Fable did **not** approve the code. Two fresh independent
Codex reviewers are required for the high-risk state/data change and were
dispatched against `83a08f83580cdf502e5f89c1fc4866f9b5f0a1d8`.

The exact implementation commit was deployed **without promotion** as Trigger
`20260904.5`, 12 detected tasks, deployment `v1ia6r1u`, image
`sha256:1e683641f54be344221275b759718afcb919ed6f2c6eba4d000d39b620b0a217`.
CLI doctor completed at that version in `run_06g6tle0u3hni93ia7veqeeu01` and
reported the shared engine plus configured provider. No paid report has been
launched for this change yet. GitHub CI run `33930840011` passed at this commit.

Both independent reviewers reported blockers on that first implementation:
unconfirmed SDK metadata flush, incomplete provider responses allowing more
spend, seller caps resetting across quality repairs, missing final action text
in fact projections, and factless parked/unavailable reports being rejected.
These are corrected with management-API pointer read-back, immediate uncertain
operation stop, report-wide publication constraints seeded into repair searches,
final-decision fact projection, and narrow factless terminal-limit validation.
Thirteen native regression tests pass. The first deployed version `.5` is not
approved for acceptance; revised exact-head reviews and deployment are required.

Re-review of `fe1b01d` confirmed those fixes and found two action-path edge
cases: the planner's internal retry loop could repeat an uncertain provider
request, and local validation of >480 actions could poison otherwise valid
state. Each action-provider request now has its own durable receipt boundary
with serial dispatch; local validation runs outside the uncertain-operation
boundary, preserving the shared engine's deterministic oversized-batch fallback.
Fifteen native regression tests cover these paths before another live test.
