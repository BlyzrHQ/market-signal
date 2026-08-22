# Bounded durable crawl checkpoint

## Problem

The first durable-resume rollout correctly preserved a successful crawl when its checkpoint was stored, but a real Babanuj canary produced no crawl checkpoint. The raw crawl snapshot exceeded the 3.9 MB callback result budget, so checkpoint creation was treated as an optional miss and Trigger task retries recrawled the storefront. Later 403 responses could therefore still leave the report cycling in crawl.

## Change

- Project crawl results into a bounded durable representation before compression.
- Retain product identity, source, price, quantity, identifier, region, discovery coverage, ad-request, and document facts needed by matching and final persistence.
- Explicitly drop duplicated crawl pages, enrichment pages, candidates, gaps, and other transport-only crawl detail from retry state.
- Preserve fields that participate in catalog identity exactly; bound only company metadata and the presentation document.
- Retry checkpoint encoding with a lean projection that removes non-identity image, alias, and claim-link detail when the richer projection still exceeds the callback budget.
- Keep the live first attempt on the original in-memory crawl; compaction affects only retry recovery.

## Validation

- Add a regression with a production-shaped multi-megabyte crawl containing duplicated `pages[].products` and `pages[].claims`, then prove task attempt 2 resumes without another crawl.
- Run the focused orchestration suite, lint, typecheck/build, and full tests.
- Review the exact PR head with verified Fable 5 before merge and deployment.
- Deploy Trigger first, then the exact merged VPS revision, and rerun real Babanuj and MyJam canaries.
