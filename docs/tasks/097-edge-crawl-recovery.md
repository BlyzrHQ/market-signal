# Task 097 — Edge crawl recovery

## Problem

The production VPS receives HTTP 403 from both public Babanuj homepage hosts, while the exact same bounded crawler deployed on Sites can retrieve the storefront and observe its product images and prices. A successful standalone edge crawl must become available to the full persisted report flow without weakening robots, throttling, redirect, or SSRF rules.

## Decision

- Keep the VPS crawler as the primary path.
- Attempt one configured Sites edge crawl only when the primary crawler has typed evidence that both canonical homepage hosts responded with HTTP 403.
- Require the one hardcoded production Sites hostname over HTTPS with the exact `/api/crawl` path, default port, and no credentials, query, or fragment.
- Authenticate the marked edge request with the existing callback credential and reject a marked request before crawling when authorization fails.
- Prevent recursive fallback with same-origin and request-marker checks.
- Bound the fallback timeout and response bytes, validate JSON content type, shape, array/string limits, domains, and evidence URLs, and require a live identity-matched primary result before accepting it.
- Preserve an explicit provenance gap, `crawlEgress: edge-recovered` coverage, and top-level recovery metadata. Never describe edge-recovered data as VPS-observed.
- Do not recover robots denial, HTTP 429, network/timeout failures, parked domains, or other HTTP statuses.
- Keep recovery at the crawl API boundary so direct API callers and Trigger-backed reports share the same behavior; the authenticated hop marker, exact distinct origin, and one-attempt guard make recursion fail closed.
- Send no target-site cookies or credentials to the edge. The only credential on the hop is the existing internal callback token used to authenticate the first-party deployment.

## Acceptance

- Unit tests prove exact-host validation, authentication, recursion prevention, response bounds, schema/URL validation, and 403-only eligibility.
- Existing typecheck, build, test, and lint gates pass.
- A fresh production Babanuj report completes through the configured edge and its product-comparison rows are measured for primary image and price coverage.
- The exact reviewed merge is deployed to VPS and Sites.

## Follow-up boundary

If the fresh report still omits images or prices for otherwise retrievable matched primary products, improve enrichment selection and coverage in a separate task. Do not expand this task into unbounded crawling.
