# Task 033 — Durable report runs in Sites D1

## Problem

The report currently exists only in React state. Reloading the page loses the crawl, competitors, product matches, ads, coverage gaps, and phase progress. A dedicated loading route and report workspace cannot be truthful or resumable without a durable run model.

## Outcome

- Extend the existing Sites-managed D1 SQLite-compatible database with report runs, ordered progress events, companies, products, matches, ads, and bounded presentation snapshots.
- Create an unguessable report id before crawling starts.
- Persist factual crawl, matching, enrichment, ad, completion, interruption, and failure events with idempotency keys.
- Save the completed report document without treating historical records as current evidence. Materialize the normalized run-owned artifact tables in production for bounded population by the tabbed workspace and matching-memory tasks; this task does not claim they are populated yet.
- Read a report by public id after the browser state is gone.
- Expose interrupted/stale states honestly and allow later route work to resume from the last completed phase.

## Acceptance criteria

1. Creating a run returns a non-enumerable public id and an initial queued event.
2. Repeating an event idempotency key does not duplicate the event.
3. Events have stable order and contain factual phase/status text, not invented percentages.
4. A completed report document survives a new request and can be reconstructed by public id.
5. Oversized documents are rejected before a D1 write; large catalogs remain relational.
6. The API does not expose an endpoint that lists all report ids.
7. Invalid domains, ids, lifecycle transitions, source URLs, and artifact payloads are rejected or bounded.
8. A stale active run becomes visibly interrupted rather than remaining “running” forever.
9. Runtime database failure is a visible persistence failure; the client never claims the report was saved.
10. A real deployed report can be created, completed, read back through a fresh request, and inspected in the in-app browser before merge.

Persistent storage is intentionally required for analysis creation in this phase. A D1 outage blocks a new free report instead of silently falling back to an unsaved one-time result.

## Data boundaries

- Run artifacts are historical public observations from a specific `observed_at` time.
- Stored competitor and product records are not reused as current evidence without a fresh crawl.
- Model verdicts retain model, prompt version, confidence, and inferred claim type.
- Public ids are access capabilities for the free flow; the API offers no report enumeration.
- Free reports expire after 90 days by default. Cleanup is bounded and must not delete another run's records.

## Validation

- Focused fake-D1 tests for schema initialization, creation, idempotent events, lifecycle transitions, document bounds, readback, and isolation.
- Route tests for input validation and non-JSON/database failures.
- Generated Drizzle migration inspection.
- Full typecheck, build, lint, Node tests, and Go tests.
- Strict Fable 5 review, exact Sites deployment, real-domain persistence probe, and in-app browser verification before Fable merges.

## Review record

- Fable 5 review round 1: `VERDICT BLOCK`. It found that the client used POST while the dynamic report route exposed only PATCH, so production would persist only the initial run. It also rejected artifact tables that existed only in the migration, incomplete terminal-state protection, replayed events that could regress the run row, unvalidated observation timestamps, and corrupt heartbeats that never became stale.
- Corrections: POST and PATCH now share the same mutation handler; every report table is materialized by the runtime schema path; late duplicate keys cannot update phase state; complete, limited, and failed reports are immutable; observation timestamps are normalized; invalid heartbeats become interrupted; focused regression coverage was added.
- Fable 5 re-review: pending. The verified model session reached its subscription session limit before returning a verdict. This is not a PASS; deployment and merge remain blocked until the strict re-review completes.
