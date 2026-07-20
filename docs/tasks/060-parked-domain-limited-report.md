# Task 060 - Parked-domain limited report

## Problem

`noororganic.com` currently resolves to a JavaScript redirect and then a GoDaddy/Afternic sale page. The crawl route detects that deterministic public state and returns a structured `409 parked-domain` response with evidence, alternatives, crawl results, and a report document. The Trigger HTTP adapter discards every non-2xx response body, so orchestration retries the crawl and ultimately exposes only `Public crawl request failed with HTTP 409.` No durable report is saved.

## Outcome

Convert only a strictly validated, source-linked parked-domain response into a terminal limited report. Persist the useful public evidence and clearly explain that competitor, product, and advertising analysis did not run because the submitted domain is not an active company website.

## Design

- The crawl route emits a `domain-status` block for a parked primary domain containing the submitted domain, `status: parked`, provider, observed public evidence URL, observation time, and possible alternative domains.
- Alternatives are explicitly unverified suggestions. They are never treated as the submitted company, crawled as its competitors, or written to competitor memory.
- The Trigger HTTP adapter accepts a non-2xx body only when all parked-domain invariants are present: HTTP 409, `ok: false`, exact code `parked-domain`, matching primary domain, a report document with a blocks array, a parked `domain-status` block, and a source-linked gap block. Every other non-2xx response remains an `OrchestrationHttpError` with existing retry semantics.
- Orchestration returns rather than throws for that typed outcome on any task attempt. It saves one `limited` document, makes no brief, ads, match, or enrichment calls, and records canonical pipeline events.
- The live summary and replay summary are identical: `completedPhases: [persistence]` and `limitedPhases: [crawl, brief, ads, matching]`.
- Events are `crawl-started`, `crawl-limited`, `brief-limited`, `ads-limited`, and `matching-limited`, followed atomically by the existing `report-saved` persistence event. Their `phase` fields are canonical pipeline phase names; skipped downstream events explain that the phase did not run because the primary crawl was terminally limited. Limited phase events retain `status: limited` while the run remains non-terminal until the document save. Replay maps the atomic save event to the canonical `persistence` phase.
- The report UI derives available tabs from the saved state. A parked report shows Overview, Evidence when evidence/gap blocks exist, and Methodology. It does not show empty Competitors, Products, or Ads tabs.
- The Overview prominently explains the parked state, lists skipped analysis, links to the blocking evidence, and labels suggested domains as choices that require user confirmation.

## Safety boundary

This terminal-limited path applies only to the crawler's deterministic parked-site classification backed by a successfully observed redirect to a known parking/sale provider. Timeouts, DNS failures, access blocks, HTTP 5xx responses, malformed 409 bodies, and ordinary empty crawls keep the existing bounded retry then failed behavior. A parked report is terminal and is not later upgraded by the same orchestration delivery.

Evidence URLs are intentionally accepted only over HTTPS. A genuinely parked site whose only observed sale-page redirect remains HTTP will fail closed through the existing retry/failure path instead of being trusted as a parked-domain result.

## Acceptance criteria

- A valid parked-domain 409 on attempt one returns `ok: true`, `reportStatus: limited`, `completedPhases: [persistence]`, and `limitedPhases: [crawl, brief, ads, matching]` without throwing.
- Spies prove zero calls to brief, ads, match, and enrich and exactly one limited document save.
- The parked report contains a source-linked domain-status block and gap evidence with an observation timestamp.
- A malformed parked response, timeout, 5xx, DNS failure, or ordinary 409 is never accepted as terminal limited.
- Replaying the stored limited run returns the same phase summary without mutation.
- The parked report renders only the truthful relevant tabs and never implies zero competitors, products, or ads were found.
- Suggested alternative domains remain unverified and user-selectable; they are not automatically analyzed or remembered.
- Existing tests, typecheck, production build, and lint remain green.
- The exact implementation is strictly reviewed by Fable 5, deployed to Sites and Trigger, and verified with a fresh `noororganic.com` production run before merge.

## Review record

- Fable 5 first returned `BLOCK`: it required a deterministic classification gate, explicit no-retry return behavior, canonical event phase names for replay parity, strict adapter validation, skipped-phase events, and dynamic report tabs that do not imply zero market activity.
- The design was revised to adopt those requirements. Fable 5 returned `PASS`, with implementation requirements for anchored provider matching, bounded error-body parsing, explicit limited event statuses, and no regression to ordinary pipeline events. The existing provider classifier already performs exact-host/subdomain matching; Task 60 adds a spoofed-lookalike regression test and validates the classified redirect domain again at the Trigger boundary.
- Fable 5's first implementation review returned `BLOCK` on one medium retry defect: `crawl-limited` used a fixed idempotency key with attempt-varying metadata, so a transient save failure followed by attempt two could conflict with the partially written event. The event is now deterministic across attempts, and a partial-write/retry regression test reproduces the storage contract.
- Fable 5's strict implementation re-review returned `PASS` after independently confirming the remediation, the tightened error validation, the documented HTTPS fail-closed boundary, `286/286` passing tests, and zero lint errors. It reported no remaining blocker, high, or medium findings.

## Local validation

- `npm test`: `286/286` tests passed, including typecheck and production build.
- `npm run lint`: no errors; one pre-existing `<img>` optimization warning in `app/components/product-design-lab.tsx`.
