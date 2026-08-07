# Task 115: keep the Trigger HTTP client alive for Agency matching

## Problem

Task 114 aligned Caddy with the 720-second Agency matcher and the 750-second Trigger operation budget. A fresh MyJam run still returned no comparison because Node's built-in `fetch`/Undici response-header timeout ended each `/api/match` request after about 300 seconds. The HTTP adapter retried once inside its total budget, explaining the repeated roughly 600-second outer calls and zero returned assignments despite 84 complete judge checkpoints.

## Change

- Use an explicit Undici `Agent` for Trigger-to-application HTTP calls.
- Set its response-header and body timeouts to 760 seconds.
- Preserve the intended ordering: 720-second matcher, 750-second operation abort, 760-second Undici boundary, 780-second Caddy boundary.
- Keep injected fetch implementations unchanged for deterministic tests.

## Validation

- Prove with a delayed-header local server that the managed fetch honors its configured dispatcher deadline.
- Assert the timeout ordering against the existing operation constants.
- Run the full test/build/lint suite and strict Fable 5 review.
- Deploy Trigger first, then the exact VPS commit, and rerun `myjam.co.uk` with Agency / 1,000.
- Require at least one published priced rival pair and zero published rivals with a non-finite, non-positive, blank, or unsupported-currency price.

## Boundaries

This does not extend the AI budget, weaken product-match vetoes, alter plan limits, or publish unpriced comparisons. It removes a lower transport timeout that preempted the already-approved operation deadline.
