# Task 056 - Authenticated persistent report jobs

## Goal

Make a submitted report continue independently of the browser by triggering the deployed `market-signal-report-orchestration` task, accepting only authenticated internal callbacks, and keeping progress and terminal results in D1.

## Product outcome

- Submitting a public domain creates one durable report run and immediately opens its loading URL.
- Closing or refreshing the loading page does not stop collection.
- The loading page polls persisted events and opens the report only after its document is stored.
- Trigger and callback failures become explicit customer-visible states; no empty report is presented as success.

## Scope

1. Add a server-only Trigger client that submits the exact Task 055 payload with an attempt-scoped report idempotency key and returns the Trigger run ID without exposing credentials. The client configures the Trigger SDK explicitly from the Cloudflare request environment instead of assuming Workers mirrors bindings into `process.env`.
2. Change `POST /api/reports` to create the D1 run, dispatch the background task, persist a queued/dispatch event, and mark the run failed if dispatch cannot be confirmed.
3. Add `GET` and `POST /api/internal/reports/[publicId]` for Trigger callbacks. Both methods fail closed unless `Authorization: Bearer <MARKET_SIGNAL_CALLBACK_TOKEN>` matches the server credential.
4. Make callback persistence replay-safe:
   - duplicate event idempotency keys return success without changing the terminal state;
   - a repeated final document returns success only when the stored run is already `complete` or `limited` and a document exists for the same report identity;
   - failed runs remain failed and cannot be overwritten;
   - the public report route is read-only for browser clients.
5. Add one explicit interrupted-run recovery operation for a server-authorized re-dispatch. It increments `attempt_count`, resets the run to `queued`, refreshes its heartbeat, clears the stale error, and appends one idempotent recovery event. No public caller can recover a run.
6. Replace browser-specific stale wording with background-job wording. Only `running` jobs use the ten-minute stale threshold because Task 055's longest silent bounded operation is five minutes and every phase emits progress before and after work. `queued` jobs are never marked interrupted by that threshold; after a separate 60-minute dispatch timeout they become explicitly `failed` with honest "the background job did not start" wording.
7. Remove crawl, brief, ads, matching, enrichment, and persistence ownership from `app/page.tsx`. Submission only creates the job and navigates to `/reports/{publicId}/loading`.
8. Configure `TRIGGER_SECRET_KEY` on Sites and the same generated callback credential as `MARKET_SIGNAL_CALLBACK_TOKEN` on Sites and Trigger production. Configure Trigger production `MARKET_SIGNAL_APP_ORIGIN` with the deployed HTTPS origin. Secrets are never committed or printed.

## Endpoint contract

### `POST /api/reports`

Input: `{ primaryDomain, locale }`.

Success: HTTP 202 with `{ ok: true, report: { publicId, primaryDomain, locale, status, currentPhase, createdAt, expiresAt }, job: { dispatched: true, runId } }`.

Dispatch failure: the created D1 run is terminal `failed`, the response is HTTP 503, and the response includes only a sanitized public message and `publicId` so the loading state remains inspectable.

### `GET /api/internal/reports/{publicId}`

Authenticated success: `{ ok: true, report }`. Missing report: 404. Missing/invalid credential: 401 with no credential detail.

### `POST /api/internal/reports/{publicId}`

Authenticated event body: `{ action: "event", idempotencyKey, phase, status, message, metadata?, errorCode? }`.

Authenticated document body: `{ action: "document", status, observedAt, document }`.

Authenticated recovery body: `{ action: "recover" }`. It is accepted only for an interrupted run, increments the persisted attempt before dispatch, and safely replays while that recovered attempt remains queued because Trigger deduplicates the attempt-scoped key.

Unknown actions are 400; conflicting replays and writes to terminal runs are 409; missing reports are 404; authentication failures are 401. Replays return HTTP 200 with `replayed: true` only when the stored state proves the original operation already succeeded.

## Security boundaries

- Trigger credentials and callback credentials are read only in server code.
- The callback credential is compared as a fixed-length SHA-256 digest using Web Crypto, so unequal raw token lengths do not create a direct early-exit comparison.
- Callback paths are constant and public IDs remain regex-validated.
- Errors returned to clients or task logs never include an authorization header, callback token, Trigger key, response body containing secrets, or arbitrary upstream HTML.
- Public analysis endpoints remain public-source tools; the bearer token sent by Task 055 does not grant extra behavior there.

## Recovery and idempotency

- A Trigger idempotency key is derived from the immutable report public ID, contract version, and stored `attempt_count`: `{publicId}:1:{attemptCount}` with an explicit 24-hour TTL. Duplicate dispatch calls for the same stored attempt deduplicate to one run; an authorized recovery increments `attempt_count` before dispatch and therefore creates a new Trigger run.
- The task payload identity must equal the stored run identity before orchestration proceeds.
- Dispatch event keys, progress event keys, recovery keys, and final save are individually idempotent.
- A running stale marker means that no durable worker heartbeat was persisted within the threshold, not that the browser closed. A queued report uses a separate dispatch deadline and is never described as interrupted.
- Recovery is a separate authorized server transition performed immediately before a verified re-dispatch; the Trigger task itself never silently revives an interrupted report.

## Validation

1. Unit tests cover auth denial, correct auth, malformed bearer values, duplicate event replay, terminal document replay, failed-state refusal, dispatch failure, running stale recovery, and queued dispatch timeout. They prove a duplicate initial dispatch returns the same Trigger run while a recovery dispatch after incrementing `attempt_count` creates a new run.
2. Route tests prove the browser no longer calls crawl/report/ads/match/enrich or writes report callbacks.
3. `npm test` and `npm run lint` pass.
4. Secret scan is clean.
5. The exact reviewed commit is deployed to Sites and Trigger production as needed.
6. A real `myjam.co.uk` submission reaches a persisted `complete` or `limited` document while the loading page only polls D1.
7. Fable 5 returns strict PASS before Fable marks the PR ready and merges it.

## Known boundaries

- This task does not claim complete Meta, Google, or TikTok ad coverage when public/API access is limited.
- Trigger submission confirms job acceptance, not eventual report success.
- Automated scheduled re-runs and customer-configurable monitoring cadence remain later work.
- The unauthenticated free-report creation endpoint can dispatch paid work; production rate limiting and abuse controls are required before public launch.

## Review record

- Fable 5 architecture review initially blocked the stale queued-job policy and recovery idempotency. The design was revised to separate the confirmed-dispatch timeout from running-worker staleness and to scope dispatch keys by persisted attempt; architecture re-review passed.
- Fable 5 implementation review initially blocked a dispatch-recording race, unreachable recovery code, and a deprecated Trigger SDK import. The implementation now isolates dispatch failure from telemetry failure, treats a fast-starting running job as a safe telemetry no-op, exposes authenticated replay-safe recovery, and imports the root SDK package.
- Fable 5 implementation re-review returned `IMPLEMENTATION GATE: PASS` after independently running 257 passing tests and lint with zero errors. Production configuration, live MyJam evidence, and final merge-gate review remain required before merge.
- Live production validation exposed an HTTP 503 before dispatch. The creation route now emits only a safe stage/diagnostic code to Worker logs and distinguishes a missing Trigger credential from a rejected Trigger request without logging credentials or arbitrary upstream error bodies.
- Production logs isolated the failure to D1 schema initialization. Runtime schema setup now executes each idempotent DDL statement sequentially, caches successful initialization per D1 binding, retries after failure, and reports only the closed failing-statement code. This avoids relying on a multi-DDL D1 batch during a customer request.
- The schema initializer completed in production and isolated the next failure to the atomic run/event creation batch. That batch remains atomic; its raw D1 error is reduced to one closed log-only class (`schema-mismatch`, `constraint`, `binding-count`, `transaction`, or `batch-api`) before any migration decision.
- The first classifier deployment showed that the runtime bundle does not preserve `instanceof` identity for the custom storage error at the route boundary. Diagnostics now cross that boundary only through the `ReportStorageError` brand plus a strict allowlist of known schema-statement and atomic-batch codes; arbitrary error properties and raw D1 details remain rejected.
- A second production run showed that Sites also strips or replaces the branded fields before the route catch. The definitive closed diagnostic is therefore emitted at the store catch point where classification occurs, at most once per code per isolate. Database import and missing-binding failures are separately identified; no caught error, SQL, stack, or credential is logged, and the public response remains generic.
- Because Sites retained only the route-level invocation error and not the store-local console event, report creation now crosses the store/route boundary as a discriminated result containing either the created run or one runtime-allowlisted diagnostic code. Raw errors never cross the module boundary; the route remains the authoritative closed log channel and client responses are unchanged.
- Result classification is total even for exotic runtime-thrown values: sentinel messages and branded codes are read only through throw-safe property access, and hostile proxies or unknown values reduce to `run-create-unclassified` rather than escaping the Result contract.
- The API route treats the store result as an untrusted cross-module value. It validates the creator, result discriminator, diagnostic allowlist, and every report field before dispatch or response; failures reduce to four closed boundary codes without logging exception text.
- Live `create-not-callable` evidence identified the root cause: Next/Sites supplies route context as the handler's second argument, which had been mistaken for test dependencies. The exported `POST` handler now accepts only the request and delegates to the separately injectable helper.

## Local validation record

- `npm test`: PASS, 259/259 tests.
- `npm run lint`: PASS with zero errors and one pre-existing `no-img-element` warning in the product design lab.
- `git diff --check`: PASS apart from platform line-ending notices.
