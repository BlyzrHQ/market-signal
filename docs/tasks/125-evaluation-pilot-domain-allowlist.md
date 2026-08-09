# Task 125 — Evaluation pilot domain allowlist

## Problem

The live database contains 25 older deterministic evaluation candidates. The
existing boolean pilot switch also enables recovery, so turning it on for one
real MyJam report could dispatch the entire backlog and exceed the USD 0.10
pilot ceiling.

## Decision

Add an optional comma-separated server-owned
`MARKET_SIGNAL_EVALUATION_PILOT_DOMAINS` allowlist:

- the main boolean remains the kill switch;
- missing, empty, or whitespace-only allowlists fail closed;
- only the unmistakable `__all__` sentinel enables future global mode;
- a non-empty allowlist permits only exact normalized report domains;
- recovery has no report domain and therefore remains disabled while an
  allowlist is present;
- invalid allowlist entries are ignored rather than widening access.

## Acceptance criteria

1. `false` never dispatches an agent evaluation.
2. `true` plus `myjam.co.uk` dispatches a terminal MyJam evaluation only.
3. Other domains and domain-less recovery remain disabled during the pilot.
4. The global sentinel mode remains explicit and tested for a later
   reviewed rollout.
5. A fresh MyJam report produces one terminal evaluation, one durable feedback
   delivery, one Codex presentation, and one immutable ACK without dispatching
   the existing backlog.
