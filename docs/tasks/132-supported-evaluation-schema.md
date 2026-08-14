# Task 132: Use a supported report-evaluation schema

## Problem

The bounded Wearform evaluation reached OpenAI but terminated as `agent_rejected` with `provider-request-rejected` and unknown usage. GPT-5.6 Luna is a documented Responses API model with Structured Outputs support. The strict output schema, however, sends the JSON Schema keyword `uniqueItems`, which is not part of OpenAI's documented Structured Outputs subset.

## Scope

- Remove `uniqueItems` from the provider-facing strict output schema.
- Retain duplicate evidence-ID rejection in the existing application validator.
- Bump evaluator, prompt-contract, and schema versions so failed immutable v2 evaluations cannot be mistaken for the corrected contract.
- Keep global automatic paid evaluations disabled and do not retry another paid evaluation on the same UTC day because the failed call's cost is unknown.

## Validation

- Assert the emitted provider schema contains no `uniqueItems` keyword.
- Assert duplicate evidence IDs are still rejected after a measured provider response.
- Run focused evaluation tests, full tests/build/typecheck, and lint.
- Obtain strict Fable 5 review before merge.
- Deploy Trigger before the exact VPS commit.
- Validate the next explicitly budgeted report evaluation on a later UTC day.

## Sources and boundaries

- OpenAI's current GPT-5.6 Luna documentation lists Responses API and Structured Outputs support.
- OpenAI's Structured Outputs guide documents a supported JSON Schema subset and does not include `uniqueItems` among supported array constraints.
- Provider rejection bodies remain bounded and are never persisted verbatim.
