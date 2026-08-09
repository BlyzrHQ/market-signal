# Task 125 — Evaluation pilot domain allowlist

## Problem

The live database contains 25 older deterministic evaluation candidates. The
existing boolean pilot switch also enables recovery, so turning it on for one
real MyJam report could dispatch the entire backlog and exceed the USD 0.10
pilot ceiling.

## Decision

Add comma-separated server-owned domain and exact public-report allowlists:
`MARKET_SIGNAL_EVALUATION_PILOT_DOMAINS` and
`MARKET_SIGNAL_EVALUATION_PILOT_REPORT_IDS`.

- the main boolean remains the kill switch;
- missing, empty, or whitespace-only allowlists fail closed;
- only the unmistakable `__all__` sentinel enables future global mode;
- both an exact normalized domain and exactly one 32-character public report ID
  are required, so repeated public submissions cannot consume evaluation cost;
- recovery has neither scoped value and therefore remains disabled;
- invalid allowlist entries are ignored rather than widening access.
- dispatch retries preserve one external idempotency key per evaluation, so an
  accepted request with a lost response cannot create another paid Trigger run.

## Acceptance criteria

1. `false` never dispatches an agent evaluation.
2. `true` plus `myjam.co.uk` and one exact public ID dispatches only that
   terminal MyJam evaluation.
3. Other domains and domain-less recovery remain disabled during the pilot.
4. The global sentinel mode remains explicit and tested for a later
   reviewed rollout.
5. A fresh MyJam report produces one terminal evaluation, one durable feedback
   delivery, one Codex presentation, and one immutable ACK without dispatching
   the existing backlog.
