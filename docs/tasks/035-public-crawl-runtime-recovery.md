# Task 035 — Public crawl runtime recovery

## Problem

A fresh production crawl of `noororganicfood.com` returned Cloudflare Worker error 1101 after 58.9 seconds. The UI converted the HTML platform error into a generic public-crawl failure even though the same domain has previously produced a real report with 312 first-party products and two verified competitors. The current route combines large-document parsing, six search lanes, up to six competitor crawls, product enrichment, document construction, and JSON serialization inside one request.

## Outcome

- Prevent product-heavy real domains from exhausting the Worker request through unbounded concurrent document processing and duplicate response material.
- Preserve the configured page, discovery-lane, candidate, and aggregate product coverage; do not relabel a reduced fixture or snapshot as a full crawl.
- Bound regex-based HTML extraction input while retaining full-document content hashing and sitemap catalog discovery.
- Return a compact, explicitly annotated report snapshot while keeping full aggregate catalogs available to the product-matching phase.
- Surface platform interruptions and lane timeouts as specific retryable or limited-coverage states.
- Record the durable background-job architecture as the required follow-up rather than hiding it inside this urgent patch.

## Acceptance criteria

1. All six discovery lanes, six candidate slots, configured page limits, and aggregate product catalogs remain enabled.
2. Competitor crawls use bounded concurrency and settle individual failures without aborting successful candidates.
3. HTML regex extraction is bounded independently from the full fetched document and content hash.
4. Product-catalog blocks in the returned report are explicitly truncated snapshots with original counts; aggregate `results[].products` retain full discovered catalogs for matching.
5. Non-JSON Worker/service responses produce a specific retryable message and the failed D1 report remains available by its report URL.
6. Regression tests cover bounded concurrency, bounded extraction, snapshot count annotations, and JSON error handling.
7. Full typecheck, build, tests, lint, Go tests, strict Fable review, exact deployment, and fresh real-domain production verification pass.

## Verified incident evidence

- Production endpoint: `POST /api/crawl`
- Domain: `noororganicfood.com`
- Observed: 2026-07-16
- Result: HTTP 500, HTML Cloudflare error 1101, Worker threw exception, after 58.9 seconds.
- Control: saved report `1d787f02518a44f899b1624e350c354a` is healthy and persisted a real 312-product primary catalog.

## Fable architecture decision

Fable 5 identified a combined CPU/memory risk from large regex passes, concurrent large-document crawls, and duplicated response serialization. It recommended a narrow bounded-processing patch now and a resumable async crawl job with streaming HTML parsing as the durable follow-up. Merge blockers include reduced lane/candidate/product limits, hidden coverage loss, removal of transient retry behavior, and absence of a product-heavy real-domain production test.

