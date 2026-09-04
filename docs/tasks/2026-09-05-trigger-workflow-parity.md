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
