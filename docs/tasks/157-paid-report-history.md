# Paid report history

## Goal

Give signed-in customers with a currently active paid plan a compact list of their recent reports in the report dashboard sidebar.

## Product and security boundaries

- History is loaded from an authenticated, private, no-store endpoint after the public report page renders.
- The server resolves the workspace from the session; callers cannot supply or override a workspace id.
- Only active or trialing subscriptions inside their current billing period are eligible.
- Responses expose only the public report id, primary domain, status, and report timestamps.
- Expired reports are excluded and the list is bounded to five entries.
- Unauthenticated and unpaid viewers do not see the component.
- Non-billing deployments return no history route, and every response is private, no-store, and varies on the session cookie.

## Validation

- Authorization tests cover anonymous, unpaid, paid, and cross-workspace behavior.
- Storage tests cover ordering, expiry filtering, and limits.
- Verified Fable 5 architecture review recommended a client-fetched private endpoint, session-derived workspace scoping, the shared active-subscription predicate, an empty-workspace guard, and private/no-store responses that vary on the session cookie. The implementation follows those boundaries; a dedicated `/api/account/reports` route was chosen instead of adding a second method to the report-creation endpoint.
- Complete test suite passed: 862 tests, 0 failures. VPS build and lint passed; lint retained two existing `<img>` performance warnings and no errors.
- Obtain strict Fable 5 review on the exact PR head before merge.
- Deploy Trigger before the VPS and verify the exact approved commit live.
