# Task 074 — Server-portable Trigger worker API

## Goal

Give the existing durable Trigger workflow one explicit, versioned application
API contract that can be implemented by the current Sites deployment and by a
future conventional server without changing the Trigger task payload.

## Why this is the next unit

Trigger already owns report sequencing, retries, idempotency, and progress
callbacks, but its HTTP adapter assumes that any configured HTTPS origin
implements the expected private routes. A wrong or partially migrated origin
can accept a paid job and fail only after report mutations begin.

The future server and hosting stack are not selected yet. Moving the crawler
into another runtime now would therefore risk a throwaway migration. A
capability preflight makes the existing boundary explicit and testable while
leaving the live Sites flow unchanged.

## Scope

- Move the report task payload contract to a platform-neutral shared module so
  the application no longer imports a contract from the Trigger deployment
  directory. Keep a compatibility re-export at the old path.
- Define worker API protocol version `1` and its required capabilities in a
  shared module.
- Add an authenticated `GET /api/internal/capabilities` endpoint.
- Make the Trigger HTTP port validate the service name, protocol version,
  required capability set, and timestamp before the first non-terminal report
  mutation.
- Treat a valid but incompatible manifest, or a deterministic `4xx`, as a
  permanent orchestration error. Transient network, `429`, and `5xx` failures
  retain the bounded Trigger retry policy.
- Preserve completed/limited replay behavior without requiring a compute
  preflight because a terminal report issues no new mutations.

## Worker API contract

Authenticated response:

```json
{
  "ok": true,
  "service": "market-signal-worker-api",
  "protocolVersion": "1",
  "capabilities": [
    "report.read",
    "report.event.append",
    "report.document.save",
    "crawl.execute",
    "ads.execute",
    "products.match",
    "products.enrich",
    "products.actions"
  ],
  "observedAt": "ISO-8601 timestamp"
}
```

The endpoint uses the existing server-only
`MARKET_SIGNAL_CALLBACK_TOKEN`. Neither the token nor the application origin
is accepted from the report task payload.

## Compatibility boundary

- A future server must expose the same authenticated manifest and required
  routes before Trigger is pointed at it.
- Additional capabilities are allowed for forward-compatible server releases.
- Protocol version changes are deliberate migrations, not inferred from
  deployment or hostname.
- This task does not move crawling into Trigger or select the future database.

## CLI and public API boundary

Fable identified that the compute routes should ultimately be authenticated.
The current Go CLI intentionally calls `/api/crawl` and `/api/ads`, so changing
those routes in this task would silently break an existing client. Route
authentication is deferred to a focused API-authentication task that first
adds a supported CLI credential contract. The new capabilities endpoint itself
is private from day one.

## Acceptance criteria

1. The shared manifest parser accepts a valid required-capability set and
   allows additive capabilities.
2. Missing capabilities, wrong service/version, duplicate or malformed
   capabilities, and invalid timestamps are rejected.
3. The endpoint returns `401` without the callback credential and a no-store
   manifest with a valid credential.
4. A non-terminal orchestration preflights before its first event or compute
   call.
5. Terminal report replay performs no preflight and no mutation.
6. Deterministic incompatibility aborts without consuming a task retry;
   transient readiness failures remain retryable.
7. Existing report payloads and successful customer flow remain unchanged.
8. `npm test`, lint, Go tests, strict Fable review, Trigger deployment, and one
   real public-domain run pass before merge.

## Architecture review

Verified Fable 5 found that the pure orchestration state machine is strong but
that the app/Trigger deployment boundary is implicit and imports flow in both
directions. It recommended extracting a shared platform-neutral contract before
moving compute. It also identified unauthenticated compute routes, retry-event
metadata drift, and dead brief surface as follow-up work. Codex narrowed this
task to the shared contract and capability gate; changing compute-route auth is
deferred because the existing Go CLI depends on those endpoints.

## Implementation validation

- `npm test`: 355 tests passed, including typecheck and production build.
- `npm run lint`: passed with zero errors and two pre-existing image warnings.
- `go test ./cli/... ./contracts/...`: passed.
- `git diff --check`: passed.
- Strict Fable 5 re-review: approved with no blocking defects after the
  critical-path budget included the preflight and timestamps required canonical
  ISO-8601.

Deployment and a real public-domain run remain merge gates and will be recorded
on the pull request so the reviewed source commit does not change afterward.
