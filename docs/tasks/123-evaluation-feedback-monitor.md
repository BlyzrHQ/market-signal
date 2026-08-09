# Task 123 — Restricted evaluation feedback monitor

## Objective

Deliver each durable report-evaluation result into the owner’s Codex task as a
short good/bad/fix breakdown, acknowledge it only after successful
presentation, and surface exact human-review questions when judgement is
required.

## Scope

- Install a dedicated `market-monitor` SSH principal with one generated key,
  no password, no forwarding, no PTY, and a forced command.
- Permit only `health`, `claim`, and exact `ack` operations. The SSH wrapper
  never evaluates caller text and the root helper validates every argument.
- Keep monitor credentials server-owned. The helper reads the root-owned env
  file and sends authorization through a mode-0600 curl config, never command
  arguments or output.
- Bound each upstream request to 20 seconds and 64 KiB. Return the already
  sanitized private API JSON unchanged on success and closed error JSON on
  failure.
- Create a recurring Codex automation for this task. Each run processes at
  most three deliveries, presents stable delivery IDs and the report link,
  then acknowledges each exact payload only after presentation succeeds.
- If a delivery contains an open human-review request, ask its exact question
  with the stable request ID. Human answer submission remains a separate
  explicit owner action and never changes the provisional score silently.

## Rollout gates

1. Keep global evaluation disabled while installing and testing the monitor.
2. Verify forced-command rejection of shells, malformed ACKs, forwarding, and
   use of owner credentials.
3. Run one controlled real public-domain evaluation and verify terminal
   evaluation → outbox → Codex presentation → immutable ACK receipt.
4. Stop if pending backlog reaches the lower-bound cap, daily known AI cost
   exceeds the configured pilot budget, or delivery/auth errors repeat.
5. Enable broader evaluation only in a separate reviewed task after the pilot
   passes.

## Acceptance criteria

1. The monitor key cannot run an arbitrary command or read runtime secrets.
2. Claim and ACK output is bounded, JSON-only, and contains no credential.
3. Failed Codex presentation is not acknowledged; lease expiry permits retry.
4. Successful presentation is acknowledged exactly once and replay is safe.
5. Human-review questions are visibly delegated with request IDs.
6. Installer is idempotent and validates its sudoers entry before mutation.
7. Tests, VPS build, lint, strict review, PR, merge, deployment, and a real
   public-domain pilot pass before global evaluation is considered.
