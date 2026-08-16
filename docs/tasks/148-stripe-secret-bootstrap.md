# Task 148 — Bootstrap Stripe runtime secrets safely

## Problem

The first production deployment of hosted billing failed closed because the
root-owned Stripe secret updater required `STRIPE_RESTRICTED_KEY` and
`STRIPE_WEBHOOK_SECRET` placeholder entries to exist before it could write the
first real values. The VPS environment intentionally had no secret
placeholders, so a valid first deployment could not proceed.

## Change

- Permit zero or one existing entry for each Stripe runtime secret.
- Append a secret when it is absent and replace it when it exists once.
- Continue to reject duplicate secret entries.
- Keep all price, hosted-billing, file-type, ownership, permission, atomic
  replacement, and no-secret-output checks unchanged.
- Add an executable regression test covering first bootstrap and duplicate
  rejection.

## Validation

- Run the focused VPS packaging test.
- Run the full test, lint, and production build suites.
- Obtain strict Fable 5 review before merge.
- Rerun the exact approved deployment and verify live billing behavior without
  printing secret values.
