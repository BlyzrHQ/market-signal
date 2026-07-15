# Task 031 — Catalog synchronization before AI product judging

## Problem

A real `noororganicfood.com` production run discovered 456 primary products and 444 products from the verified competitor `bluepassionkw.com`, but the matching route retained 400 per catalog, selected only the first 30 primary families, assessed 24, judged 48 candidate pairs, and assigned no pairs. The report can therefore look as though hundreds of products were rejected even though most were never considered by semantic retrieval or the AI judge.

The current cross-language retrieval also narrows each rival catalog through an 8-bit signature before exact cosine scoring. This is too lossy for Arabic-to-English product discovery. Sitemap records without an explicit title retain encoded URL path text instead of a decoded product identity.

## Outcome

- Decode safe percent-encoded sitemap product slugs, including Arabic, without failing on malformed escapes.
- Synchronize the complete bounded primary and competitor catalogs before selecting AI work.
- Rank candidates across each synchronized rival catalog with a bounded semantic projection, then exact cosine and lexical evidence.
- Send the strongest candidate-bearing primary groups to the AI judge instead of the first catalog records.
- Preserve strict `same_product` and `close_substitute` decisions; broader retrieval must not lower acceptance standards.
- Show separate counts for synchronized products, AI-assessed products, assessed candidate pairs, and accepted pairs.

## Acceptance criteria

1. A percent-encoded Arabic sitemap path becomes readable Arabic product text when no sitemap title exists.
2. A malformed percent escape remains a safe deterministic fallback and does not abort sitemap extraction.
3. A strong semantic match late in both catalogs reaches the judge even when the AI assessment limit is much smaller than the catalog.
4. Matching input retains at least 600 valid products per catalog while remaining explicitly bounded.
5. Coverage reports do not imply synchronized-but-unassessed products were rejected.
6. Existing product vetoes and exact-price safeguards continue to pass.
7. The real Noor production run synchronizes both broad catalogs and returns useful product pairs, or exposes a specific measured coverage gap rather than a false zero-result conclusion.

## Validation

- Focused unit tests for sitemap decoding, late-catalog semantic retrieval, route bounds, and coverage copy.
- Full typecheck, build, lint, Node tests, and Go tests.
- Strict Fable 5 review with blockers addressed.
- Real production crawl and match for `noororganicfood.com`, followed by browser verification of the rendered coverage and product cards.

## Data boundaries

Product names, URLs, images, and prices remain observed public evidence. Semantic similarity and `same_product` / `close_substitute` verdicts remain labeled inferences. A synchronized product is not described as assessed or rejected unless it reached the AI judge.

## Review record

Fable 5's first architecture review blocked the old funnel because the live evidence harness skipped `/api/match`, the first catalog rows consumed the judge budget, and 8-bit retrieval starved semantic candidates. Its implementation review found no correctness bug but required a larger structured-output allowance for four-group batches, real Noor retrieval timing, removal of a vacuous candidate metric, semantic-plus-baseline merging in the panel, and alignment of the remaining sitemap bound. These findings were incorporated before production validation.
