# Task 047: MyJam crawl CPU recovery

## User outcome

Submitting `myjam.co.uk` completes the public crawl and advances to competitor and product analysis instead of ending with “The public crawl could not be completed.”

## Production evidence

- `https://myjam.co.uk/` returns HTTP 200 HTML and is publicly reachable by the Market Signal user agent.
- The homepage is approximately 888 KB and the sitemap exposes a large product catalog.
- Sites Worker logs for `POST /api/crawl` show `outcome: exceededCpu`, roughly 32 seconds of CPU, and a Cloudflare 1101 response.
- A local primary-only crawl discovers 600 bounded product records in about 0.4 seconds of CPU, so primary availability is not the failure.
- The full-catalog lexical matcher currently finds one-edit token neighbours by scanning every rival token for every primary token. That work grows sharply across multiple 600-product catalogs.

## Scope

- Preserve the existing 600-product catalog ceiling and full-catalog matching coverage.
- Replace repeated vocabulary-wide fuzzy-token scans with a deletion-signature candidate index, followed by the existing exact `editDistanceAtMostOne` verification.
- Preserve matching eligibility, scoring, source links, and evidence semantics.
- Add regression coverage for exact, insertion, deletion, substitution, short-token, and unrelated-token behavior.
- Benchmark the revised matcher with a MyJam-sized multi-catalog fixture and validate `myjam.co.uk` against the deployed application.

## Non-goals

- Do not reduce the crawl to fixture data or a shallow first-page sample.
- Do not lower the 600-product catalog limit merely to fit the worker budget.
- Do not weaken product-pair vetoes or accept unverified competitors.
- Do not change ads, report presentation, or persistence behavior.

## Acceptance criteria

1. The indexed candidate lookup returns the same eligible one-edit token neighbourhood as the existing brute-force rule.
2. Automated TypeScript, build, lint, and Go checks pass.
3. A real `myjam.co.uk` production run returns JSON successfully and produces a saved report.
4. Sites Worker logs no longer show an exceeded-CPU outcome for the verified run.
5. Strict Fable 5 review returns PASS before Fable marks the PR ready and merges it.
6. The exact reviewed commit is deployed and the live report URL is verified.

## Data boundaries

- All customer and competitor facts remain sourced from live public pages and public search evidence.
- The performance fixture is test-only and is never returned as customer data.
- Missing pages, blocked pages, and product-identity conflicts remain visible gaps.

## Review and validation record

- Fable 5 architecture review initially returned **BLOCKED** because competitor verification still performed an uncapped 600 × 600 `scoreProductPair` cross-product for every investigated company. The implementation now shares the indexed, eligibility-preserving candidate gate between report comparison and competitor verification.
- The index emits exact signatures for every token and delete-one UTF-16 signatures for tokens of at least five code units, then retains the existing `editDistanceAtMostOne` function as the final verifier.
- Candidate products are deduplicated per primary token before the existing two-token hit gate, and SaaS plan pairs retain their existing bypass.
- One 600 × 600 verification fixture produced the same single eligible pair while reducing measured CPU from approximately 19,844 ms for brute-force scoring to approximately 62 ms for indexed scoring.
- A production-shaped local benchmark covering six competitor verifications plus two full seven-catalog comparisons completed in approximately 562 ms CPU with 600 products per catalog.
