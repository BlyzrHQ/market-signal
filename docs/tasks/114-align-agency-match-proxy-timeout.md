# Task 114: align the VPS proxy with Agency matching

## Problem

The first live MyJam Agency run persisted 84 completed AI judge checkpoints, including accepted priced matches, but both `/api/match` calls ended at the VPS edge before returning a response. Caddy allowed 330 seconds per upstream request while the Agency matcher has a 720-second application budget and Trigger allows 750 seconds for transport. The orchestration therefore received no comparison and safely published zero rival pairs.

## Change

- Raise Caddy's upstream response-header timeout to 780 seconds.
- Keep the timeout above both the 720-second matcher budget and the 750-second worker transport budget.
- Add a packaging regression assertion so deployment configuration cannot silently fall below the supported Agency request window.

## Validation

- Run the VPS packaging test and the full test/build/lint suite.
- Obtain a strict Fable 5 review before merge.
- Deploy Trigger first, then the exact merged VPS commit.
- Run a fresh `myjam.co.uk` Agency report and verify that at least one priced comparison is published and no published rival has an invalid price or currency.

## Boundaries

This does not increase the AI budget or weaken the priced-only publication gate. It only prevents the reverse proxy from terminating a request that is still within the approved application and worker budgets.
