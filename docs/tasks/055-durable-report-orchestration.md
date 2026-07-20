# Task 055 - Durable Trigger report orchestration

## Goal

Move ownership of the report phase sequence out of the browser and into one durable Trigger.dev task, while keeping Sites authentication and route activation in Task 056.

## Current problem

`app/page.tsx` currently owns the entire report run. Closing the tab interrupts crawling, competitor discovery, market briefing, ads checks, semantic product matching, selected product enrichment, and final D1 persistence. The loading route can only observe a run; it cannot continue it.

## Scope

- Add a strict, versioned Trigger payload for an already-created report run: `publicId`, `primaryDomain`, and `locale`.
- Add a pure orchestration state machine whose dependencies are injected through a `ReportOrchestrationPort`.
- Add one production Trigger task, `market-signal-report-orchestration`, as a thin environment/transport wrapper around that pure state machine.
- Preserve the existing real analysis order:
  1. persist `crawl-started`;
  2. crawl the primary domain and discover/verify competitors;
  3. persist `crawl-complete`;
  4. run market brief, attributable ads coverage, and semantic matching as independently limited phases;
  5. run selected product enrichment when matching returns eligible targets;
  6. upsert ads and product-comparison blocks into the report document;
  7. persist a `complete` or visibly `limited` document.
- Keep observed facts, inferred matches, explicit coverage gaps, and recommendations distinct by preserving existing route outputs without inventing fallback facts.
- Add deterministic tests for success, partial coverage, transport failures, duplicate delivery, bounded retries, payload validation, and secret hygiene.
- Read the stored run before any work and require its domain and locale to match the task payload exactly.
- Treat a replay of an already-successful terminal run as success instead of turning a completed customer report into a failed Trigger run.

## Contract

The production task accepts only:

```ts
{
  contractVersion: "1";
  publicId: string;       // exactly 32 lowercase hex characters
  primaryDomain: string;  // canonical public hostname, no scheme/path
  locale: "en" | "ar";
}
```

The caller cannot provide an origin, callback URL, token, model, or arbitrary path. The application origin and callback credential come only from server-side Trigger environment variables.

The task returns a bounded operational summary, not the customer report:

```ts
{
  ok: true;
  contractVersion: "1";
  publicId: string;
  reportStatus: "complete" | "limited";
  completedPhases: string[];
  limitedPhases: string[];
  startedAt: string;
  finishedAt: string;
}
```

Before phase 1, the state machine reads the stored run through the port. It hard-fails without retry when the run is missing or when its stored `primaryDomain` or `locale` differs from the validated payload. When the stored run is already `complete` or `limited`, the state machine returns an idempotent success summary without issuing another mutation. A stored `failed` run is not silently converted to success.

## Transport boundary

The orchestration core receives a port with typed methods for loading the stored run, progress/heartbeat events, crawl, brief, ads, matching, selected enrichment, and final document persistence. It does not read environment variables or call `fetch` directly.

The Trigger wrapper creates the HTTP port from:

- `MARKET_SIGNAL_APP_ORIGIN`: required HTTPS origin; path, query, fragment, username, and password are rejected.
- `MARKET_SIGNAL_CALLBACK_TOKEN`: required server-side credential; never accepted from task payload or logged.

The HTTP port constructs URLs only from the validated environment origin, constant route paths, and the regex-validated `publicId`. It never follows or builds a callback URL from task payloads or response data. Errors exposed to Trigger logs are sanitized and cannot include an `Authorization` header or callback-token value.

Task 056 will add the authenticated Sites endpoints, configure the same callback credential on both systems, trigger this task from report creation, and remove browser ownership of the phase sequence. Until then, Task 055 is deployed but intentionally not invoked for customer runs.

## Failure and retry policy

- Task-level retries: maximum two attempts, randomized exponential delay. The Trigger wrapper passes explicit attempt context (`attemptNumber` and `isFinalAttempt`) into the pure state machine. Event/document callbacks are idempotent by report ID plus event key, and a replay after a successfully persisted terminal document resolves as idempotent success.
- Individual HTTP requests: one initial attempt plus one retry only for timeout, network failure, `408`, `425`, `429`, or `5xx`. Deterministic `4xx` responses are not retried.
- Crawl is required. On a non-final Trigger attempt, a crawl failure records only a non-terminal progress failure (or no mutation) and throws so the retry budget remains usable. Only the final attempt records terminal `failed` before throwing; no empty report is presented as success.
- Brief, ads, matching, and enrichment are independently limited. Their failures become explicit coverage gaps and do not erase successful crawl evidence.
- Every operation has one total wall-clock budget shared by its initial HTTP request and retry; retries cannot double the deadline. Crawl is capped at five minutes, matching at ninety seconds per application attempt, enrichment at two minutes, and callback operations at ten seconds. The tested worst-case critical path is 680 seconds, preserving more than three minutes beneath the task's 15-minute ceiling. The caller supplies a single-concurrency-per-report key in Task 056.
- Customer-visible heartbeats are persisted at a cadence below the existing 10-minute stale threshold. Task 055 limits every individual port operation to at most five minutes and persists a progress event before and after every phase. Task 056 owns store-level stale-marker wording, threshold changes, and deliberate recovery of a previously `interrupted` run; Task 055 hard-stops an already interrupted run rather than mutating it without that recovery contract.
- No exact ad-spend claim or unobserved price/image is synthesized during failure recovery.

## Non-goals

- No public page or API route starts the Trigger task in this PR.
- No callback route is added or authentication scheme activated in this PR.
- No D1 schema or Sites UI behavior changes in this PR.
- No runtime secret is committed.
- No custom domain work is included.

## Acceptance criteria

1. The pure state machine is fully testable without network access, Trigger credentials, or Cloudflare bindings.
2. Contract validation rejects malformed IDs/domains, schemes, paths, extra caller-controlled transport fields, and unsupported versions.
3. Tests prove required crawl failure on non-final versus final attempts, final-attempt catch-all failure recording, partial-phase limitation, idempotent event keys, terminal-success replay, truthful replay phase lists, bounded retry classification, stored-run identity validation, selected enrichment success/failure, heartbeat cadence, and final status selection.
4. Tests prove that HTTP error messages never expose the callback token or `Authorization` header value and that request URLs are constructed only from validated configuration plus constant paths and the validated report ID.
5. `npm test` and `npm run lint` pass and all Trigger sources are typechecked.
6. Secret-pattern scan is clean.
7. Strict Fable 5 architecture and implementation reviews pass.
8. The exact reviewed commit deploys to Trigger production and detects both the existing healthcheck and the new orchestration task.
9. End-to-end MyJam execution remains an explicit Task 056 gate after authenticated Sites callbacks exist; Task 055 must not claim that customer orchestration is active.

## Review and validation

- Fable architecture review: PASS after the contract was revised for terminal replay, attempt-aware failure, an eight-minute heartbeat ceiling, stored-run identity validation, constant URL construction, and secret-safe errors.
- Fable implementation review: PASS after the first review blocked because per-request retry timeouts could double the operation deadline and the worst-case phase chain could exceed the 15-minute task ceiling. Total operation budgets, an explicit 680-second critical-path assertion, final-attempt catch-all failure persistence, 404 handling, truthful replay phases, and enrichment coverage tests resolved the findings.
- Implementation review, tests, production deployment, PR, and merge: pending.
