# Bounded durable crawl checkpoint

## Problem

The first durable-resume rollout correctly preserved a successful crawl when its checkpoint was stored, but a real Babanuj canary produced no crawl checkpoint. The raw crawl snapshot exceeded the 3.9 MB callback result budget, so checkpoint creation was treated as an optional miss and Trigger task retries recrawled the storefront. Later 403 responses could therefore still leave the report cycling in crawl.

## Change

- Project crawl results into a bounded durable representation before compression.
- Retain product identity, source, price, quantity, identifier, region, discovery coverage, ad-request, and document facts needed by matching and final persistence.
- Explicitly drop duplicated crawl pages, enrichment pages, candidates, gaps, and other transport-only crawl detail from retry state.
- Preserve fields that participate in catalog identity exactly; bound only company metadata and the presentation document.
- Preserve every catalog field used by candidate retrieval and scoring, including images, aliases, and claim links; fail closed if the lossless matching-state projection cannot fit the callback budget.
- Keep the full product-comparison baseline as computation state while compacting the separate presentation document around it.
- Fail closed when lossless checkpoint projection exceeds its budget; keep transport/storage ambiguity recoverable only when an exact committed checkpoint can be adopted.
- Recover newest-first, stop after the first valid crawl checkpoint, and cap validation to two 16 MiB candidates.
- Keep the live first attempt on the original in-memory crawl; compaction affects only retry recovery.

## Validation

- Add a regression with a production-shaped multi-megabyte crawl containing duplicated `pages[].products` and `pages[].claims`, then prove task attempt 2 resumes without another crawl.
- Run the focused orchestration suite, lint, typecheck/build, and full tests.
- Review the exact PR head with verified Fable 5 before merge and deployment.
- Deploy Trigger first, then the exact merged VPS revision, and rerun real Babanuj and MyJam canaries.
