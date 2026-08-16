# Task 147: Stripe workspace subscriptions

## Outcome

Add paid hosted accounts to Market Signal with Stripe-hosted subscription Checkout and Customer Portal management. A verified workspace subscription becomes the sole authority for hosted report allowance and per-report product limits.

## Scope

- Enable Better Auth email/password account creation and sign-in on the Node deployment.
- Persist Stripe customer and subscription state against personal workspaces.
- Offer Starter, Solo, Growth, and Agency monthly subscriptions through hosted Checkout.
- Process signed, idempotent Stripe webhooks and expose Customer Portal access.
- Enforce active subscription status and atomic monthly report quotas before dispatching paid work.
- Snapshot the resolved plan and product limit on every report.
- Add an account page and connect pricing calls to action to Checkout.

## Product and security boundaries

- Browser-provided plan, price, customer, workspace, and entitlement values are never trusted.
- Price IDs are mapped from server-only environment variables to the canonical plan catalog.
- Report creation requires an authenticated workspace with an active or trialing subscription.
- Webhooks require a valid Stripe signature and are idempotent by event ID.
- No API keys, webhook secrets, customer data, or fixture billing results are committed.
- Automatic tax is not enabled until tax registrations and business requirements are confirmed.
- The open-source self-hosted path remains available without hosted billing.

## Validation

- Unit/integration coverage for plan mapping, subscription state, webhook idempotency, authentication boundaries, quota reservation, failure release, and pricing/account UI.
- Full typecheck, lint, build, and test suite.
- Stripe test-mode Checkout/webhook validation with configured deployment secrets before release.
- Strict reviewer PASS under `AGENTS.md`, followed by exact-commit deployment verification.

## Known deployment dependency

The VPS needs server-only Stripe restricted-key, webhook-signing-secret, and test price-ID environment values. The webhook endpoint must be registered only after the final public URL is known.

## Review record

- Verified Fable 5 strict review initially returned `FAIL` after independently running typecheck, lint, both deployment builds, and the then-current 873-test suite.
- Blockers found: mandatory billing broke self-hosted deployments; Checkout could duplicate remote subscriptions; stale webhooks could revoke current access; valid unmapped events retried forever; and payment trust boundaries lacked route-level tests.
- Remediation: hosted billing is now explicitly opt-in; Checkout checks local and Stripe state; webhook updates reconcile authoritative Stripe state and reject stale regressions; unmapped valid events are acknowledged and recorded; and signed Checkout/webhook/Portal/report-boundary tests cover the failure paths.
- Revised validation: typecheck passed; lint passed with two pre-existing image warnings; Cloudflare/Vinext build passed; VPS build assertion passed; all 878 tests passed; `git diff --check` passed.
- Verified Fable 5 re-inspected the correct revised tree, independently reran typecheck, lint, both deployment builds, and all 878 tests, and returned `VERDICT: PASS` with no blockers.
- Non-blocking follow-ups: prune old webhook-event receipts, improve post-Checkout webhook-pending UX, and consider preventing simultaneous different-plan Checkout sessions.
- Remaining release gate: publish the reviewed commit, deploy that exact commit with server-owned test-mode secrets, and verify Checkout, signed webhook delivery, subscription state, quota enforcement, and Customer Portal before merge.
