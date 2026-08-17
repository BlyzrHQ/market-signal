# Task 161: Send returning users to their reports

## Problem

Email sign-in created a valid session but only refreshed the account billing
card. Returning customers therefore stayed on the sign-in/account page instead
of reaching the saved-report dashboard.

## Scope

- Prefer an explicitly requested safe same-origin return path after successful
  authentication.
- Otherwise, open the newest saved report so the customer immediately sees the
  existing **Your reports** navigation.
- Keep customers with no eligible saved reports on the account page.
- Reject external, protocol-relative, malformed, and account-loop redirects.

## Validation

- Unit-test safe return-path handling and newest-report selection.
- Run account/auth/report-history tests, lint, build, and the full test suite.
- Verify the behavior against the deployed hosted account flow before calling
  the task complete.

Local result: lint completed with only two pre-existing image warnings; build,
TypeScript checks, all 879 Node tests, Go tests, and Go vet passed.

Verified Fable 5 strict review found and drove fixes for two URL-normalization
open-redirect variants (backslash/control normalization and normalized leading
double slashes). After regression coverage was added, Fable 5 re-reviewed the
exact current diff and returned `STRICT PASS — no blockers`.

## Data boundary

The redirect uses only the authenticated, tenant-scoped account report-history
endpoint. No report identifier is accepted unless it matches the public report
identifier format, and no cross-origin redirect is allowed.
