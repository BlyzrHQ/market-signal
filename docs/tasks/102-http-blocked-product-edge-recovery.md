# Task 102 — HTTP-blocked product edge recovery

## Problem

The first persisted VPS report after Task 101 proved that catalog identity reconciliation is correct but does not run successfully from every production egress. Report `1025b0a8885642dea273a43fb5f5846a` completed for `babanuj.com`, yet the VPS received HTTP 403/non-HTML responses for all 60 robots-allowed preliminary catalog-reconciliation pages.

The saved primary catalog therefore contained 40 product snapshots, only 20 with an image and 20 with a public price. The four known in-place catalog replacements remained under their stale sitemap names with no image, price, or replacement audit. The comparison contained 67 rows, with only 15 primary images and 15 primary prices.

The same public Babanuj pages were fetched successfully by the exact reviewed code from the trusted Sites deployment. Task 100 already showed that self-hosted Firecrawl returned the same discovery set and product evidence and did not justify its additional six-service runtime.

## Decision

Add a bounded Node-only recovery for product targets whose local enrichment failed before producing a product. Send only failed targets as one batch to the exact allowlisted Sites `/api/enrich-products` endpoint. That endpoint must independently re-check robots directives and apply the same extraction and catalog-replacement identity gates.

Do not add Firecrawl, an arbitrary proxy, browser evasion, or fixture values.

## Scope

- Share one local-first product-enrichment helper between primary price enrichment and full-catalog reconciliation.
- Preserve Task 099's separate `robots_unreachable` path: Sites independently resolves and enforces robots, and fails closed if it cannot. Add Task 102 eligibility only for a locally robots-allowed product whose typed failure is a network/timeout status `0` or HTTP `401`, `403`, `407`, `429`, or `451`.
- Never edge-recover HTTP `404`/`410`, other HTTP statuses, successful non-HTML content, `robots_disallowed`, identity mismatch, adapter limitation, redirects, or a locally successful target. Eligibility is based on structured `failureKind`/`httpStatus`, never reason text.
- Keep the existing exact endpoint allowlist, Node-only deployment gate, HTTPS/source/domain/product-ID sanitization, 64-target maximum, timeout, response-size bound, and fail-closed behavior.
- Preserve local successes and do not send them to the edge.
- Remove a local per-product gap only when a validated recovered product with the same ID is accepted.
- Expose requested/recovered edge counts in existing enrichment coverage and retain explicit gaps for unresolved targets.
- Preserve all Task 101 catalog replacement, duplicate collapse, audit, and final-enrichment protections.

## Required validation

- Unit tests prove only unresolved eligible targets are forwarded in one bounded batch.
- Unit tests prove local successes are retained and never retried.
- Unit tests prove rejected/malformed/wrong-source edge results fail closed and retain gaps.
- Route tests prove primary enrichment and catalog reconciliation use the recovery helper without exceeding existing page caps.
- Focused tests, full test/build/typecheck, and lint pass.
- A real VPS/Trigger Babanuj report shows non-zero validated edge recovery, the four known replacement URLs under their current identities, and public images and prices sourced from those pages.
- The saved report and product table are inspected, not only the raw crawl response.

## Review record

- Verified Claude Fable 5 was requested first and reported its session limit with a 6:10pm Cairo reset.
- The repository's standing fallback rule delegated the architecture gate to a strict GPT-5.6 subagent.
- Decision: **PASS-A** — use the trusted Sites edge, not Firecrawl and not no-op. The reviewer required exact endpoint and Node gates, authenticated requests, a 64-target cap, independent edge robots enforcement, typed failure eligibility, strict response sanitization, no retry of local successes, explicit recovery coverage, and a real persisted Babanuj acceptance report.
- Follow-up clarification: preserve Task 099 separately; combine both eligible paths by product ID; Task 102 must add structured `failureKind`/`httpStatus` and reject 404, 410, successful non-HTML responses, 5xx, robots denial, identity mismatch, adapter limitation, redirects, and local successes.
- First implementation review: **BLOCK**. The reviewer found that a response-body read failure could erase an already observed HTTP status, the recovery transport did not independently reject more than 64 targets before egress, and response coverage could contradict the returned product count.
- Corrections: non-success responses now preserve their HTTP status without reading the body; only a pre-response fetch rejection receives network status `0`; the transport rejects 65 or more targets with zero egress; and response validation requires requested, fetched, returned-product, and maximum-page counts to agree.
- Second review: **BLOCK** only because the primary-price recovery wiring lacked a route-level regression test.
- Final correction: the route-level helper test now proves a `403` is forwarded, a `404` is not, recovered image/price data is merged, and the 16-page coverage cap remains truthful.
- Final strict fallback review: **PASS**, no findings. Claude Fable 5 had reported its session limit, so this review used the repository-approved strict GPT-5.6 subagent fallback.

## Local validation

- Focused product enrichment, edge recovery, route authentication, primary-price route wiring, and catalog reconciliation tests: **72 passed, 0 failed**.
- Full typecheck, Sites build, and test suite: **508 passed, 0 failed**.
- VPS build and no-Wrangler assertion: **passed**.
- ESLint: **0 errors** and two pre-existing `<img>` performance warnings outside this task's behavior.
- `git diff --check`: **passed**.
- Live acceptance remains pending until the reviewed commit is merged and the exact commit is deployed to Sites, Trigger, and the VPS.
