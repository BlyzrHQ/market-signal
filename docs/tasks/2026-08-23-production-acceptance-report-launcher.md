# Production acceptance report launcher

## Outcome

Provide one auditable, unbilled, internal-only way to launch a real production
report at an exact server-owned plan quota. This exists to prove the published
comparison-pair contract at 20, 50, 500, and 1,000 rows without changing a
customer subscription or accepting a client-selected plan on the public API.

## Boundaries

- The endpoint requires the owner-write credential (which is not available to
  Trigger tasks) and returns no credential material.
- The GitHub workflow runs only in the protected production environment and
  verifies that the exact requested revision is the currently deployed app
  image before it creates one report.
- The report has no workspace or billing reservation and records an explicit
  `production-acceptance` event with plan, pair target, and purpose.
- One workflow invocation creates exactly one report. Concurrency prevents two
  acceptance invocations from running at the same time.
- Public account report creation remains billing-owned and cannot select its
  plan from request data.

## Acceptance

- Missing or incorrect internal authorization performs no work.
- Starter, Solo, Growth, and Agency map to exactly 20, 50, 500, and 1,000
  published comparison pairs.
- Dispatch errors are sanitized and leave the created run failed rather than
  pretending that work started.
- Unit, packaging, lint, build, and full test validation pass.
- Strict Fable 5 review passes on the exact PR head before merge.
- After deployment, launch MyJam Starter only, verify a terminal report and 20
  valid priced comparison rows, then consider the larger quota proofs.
