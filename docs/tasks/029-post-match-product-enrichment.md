# Task 029 — Post-match product price and image enrichment

## Problem

The catalog crawler discovers hundreds of first-party product URLs, but sitemap-only records usually have no price and some competitor sitemaps have no image. The existing bounded enrichment runs before the AI matcher and fetches at most six pages selected by the lexical baseline. AI-selected pairs can therefore reach the report without their product pages ever being fetched.

MyJam also exposes authoritative Shopify price metadata and a secure image URL that the current fallback parser does not use. Its lower-quality page record can replace the secure sitemap image with an insecure `http://` URL. Some competitor pages expose structured product details that contradict their URL slug, so accepting them without an identity check can attach the wrong price and image to a match.

## Scope

- Extract authoritative Open Graph commerce price metadata and prefer secure image metadata.
- Merge enriched product fields without losing a secure sitemap image.
- Reject enriched product records when the fetched page identity contradicts the requested product URL.
- Enrich the final AI-selected comparison pairs after matching, within an explicit request/page budget.
- Keep missing price/image coverage visible and never invent values.

## Acceptance criteria

1. A MyJam-style Shopify page with `og:price:amount`, `og:price:currency`, `og:image`, and `og:image:secure_url` produces one attributable product record with the authoritative price and HTTPS image.
2. Enrichment preserves an existing HTTPS sitemap image when a lower-quality page exposes an HTTP image.
3. A fetched page whose structured/title identity contradicts the requested product slug is rejected for enrichment with a visible gap.
4. Final AI-selected product pairs can request bounded post-match page enrichment; the returned comparison uses fresh prices and images from those exact selected pages.
5. Public price deltas remain hidden when currency, variant, pack size, or product identity is unresolved.
6. Unit tests, rendered-source assertions, build, lint, JavaScript tests, CLI Go tests, and contracts Go tests pass.
7. A real MyJam production run demonstrates selected pairs with attributable prices/images or an explicit per-source coverage reason.
8. Strict Fable 5 review passes before merge. Browser QA verifies the deployed flow before Fable merges the stacked PR chain.

## Data boundaries

- Prices and images must come from the currently fetched first-party product page or its same-domain sitemap.
- AI may judge product equivalence but must not generate, estimate, or repair prices or image URLs.
- Enrichment responses are request-scoped; durable competitor memory continues to store leads only.
- Robots rules, same-domain redirect checks, timeouts, and bounded concurrency remain mandatory.

## Validation

- `npm.cmd test`: PASS (typecheck, production build, 140 JavaScript tests).
- `npm.cmd run lint`: PASS.
- `go test ./...` in `cli/`: PASS.
- `go test ./...` in `contracts/`: PASS (no test files).
- Real route probe: a current MyJam lamb-leg page returned attributable `GBP 39.05` and a secure Shopify product image; a contradictory eGrocers product page was rejected with a source-specific identity gap.

## Strict review

- Fable 5 verified the implementation and local quality gates, identified one stale-run race, and returned `FABLE_TASK_029_PASS` after the race fix and regression assertion.
- Production MyJam and in-app browser verification remain required before the stacked PR chain can be merged.
