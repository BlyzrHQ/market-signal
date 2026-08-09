# Task 126: Repair the report-evaluation provider contract

## Outcome

Make future report-quality evaluations use a current, supported, cost-sensitive
OpenAI model and return a useful bounded failure category when the provider
rejects a request. Keep the global evaluation switch off during rollout.

## Trigger

The controlled MyJam pilot report `d8d4a65b46dc497c98ce4ed48a612d98`
completed, but evaluation `f363e62e-77bd-496a-b5e2-b02deddf2498` ended as
`agent_rejected`. Trigger recorded an OpenAI HTTP 4xx and no measured usage.
The configured dated model ID was not present in the current model catalog.

## Changes

- Replace the unsupported dated model ID with `gpt-5.6-luna`, the current
  cost-sensitive model requested for this project.
- Bump the evaluator and prompt versions so old immutable evaluations cannot be
  confused with the corrected contract.
- Update metering to the documented standard rates: USD 1.00/M ordinary input,
  USD 1.25/M cache writes, USD 0.10/M cache reads, and USD 6.00/M output.
- Carry cache-write tokens through the Trigger callback contract and SQLite so
  each evaluation's persisted cost remains auditable.
- Use low reasoning effort and the existing 1,200-token output ceiling to keep
  the bounded quality judgment inside the pilot cost envelope.
- Force the standard service tier and reject cost attribution when the provider
  does not confirm that tier in its response.
- Parse at most 4 KiB of a rejected provider response and persist only an
  allowlisted safe category such as `provider-model-unavailable`,
  `provider-auth-invalid`, `provider-rate-limited`, or
  `provider-request-rejected`. Never persist provider body text.
- Add exact request-contract and rejection-classification tests.

## Boundaries

- Do not rerun a paid evaluation on the pilot UTC day because the previous
  provider attempt has unknown usage.
- Do not enable evaluation globally or dispatch the historical backlog.
- Do not commit or print OpenAI or Trigger credentials.

## Validation

- Focused evaluation contract, Trigger, pricing, and store tests.
- Full test, VPS build, lint, and diff checks.
- Strict Fable review, or the documented two-independent-reviewer fallback only
  while Fable returns its session-limit error.
- Deploy Trigger before the VPS exact approved commit. Leave evaluation off.
