# Task 014 — Decision-first products and official ad libraries

## Problem

The live report exposed crawl mechanics and lexical overlap instead of answering which rival product can win, why, and what the user should do. Shopify parent sitemaps were not followed into product sitemaps, non-Latin product words were stripped during matching, official ad libraries were not searched, and narrow layouts could overflow horizontally.

## Scope

- Follow child product sitemaps and retain attributable public product names and image URLs.
- Discover sellers by searching representative product names in-region, crawl the cited rival product URL first, and admit a competitor only after product-level matching succeeds.
- Preserve multilingual product names during matching.
- Show only the strongest defensible product battles with price/offer verdicts, buyer implications, recommended moves, and both source links.
- Search Meta, Google, and TikTok official transparency domains through required, domain-filtered web search; never convert access failure into “zero ads.”
- Provide exact official-library searches even when automatic creative verification is blocked.
- Remove shared-term chips and unmatched-product dumps from the user-facing report.
- Prevent horizontal page overflow and improve multilingual typography.
- Add an English/Arabic switch with RTL layout and Arabic decision-interface labels.

## Truth boundaries

- Sitemap records prove a public product URL and title, not availability or current price.
- Product matching remains evidence-based and is not product equivalence.
- Ordinary commercial ad spend is not reported as exact.
- “Verified active” requires a direct record URL—not a brand page or generic search result—on the matching official ad library, and the UI must show that record.
- No verified result means unverified coverage, never no advertising activity.
- Competitor confirmation requires the same inferred region, at least two meaningful shared product-name terms, and a proving rival product URL that was actually fetched.

## Acceptance

- A Shopify parent sitemap produces real product records from its child product sitemap.
- Broad same-category businesses are excluded unless a matching product page is verified.
- Arabic product terms survive normalization and can support matching.
- The report explains why a rival may win and recommends a specific next move.
- Official ad-library access and limitations are visible and actionable.
- The page cannot scroll horizontally at narrow viewport widths.
- English and Arabic modes remain readable with correct LTR/RTL direction.
- Build, lint, automated tests, real `myjam.co.uk` validation, strict Fable 5 review, deployment, and merge all pass.

## Review record

- Strict Fable 5 review iterated through four FAIL rounds covering false matches, region gating, ad-evidence honesty, SSRF/redirect safety, Arabic completeness, and full-URL canonicalization.
- Final Fable 5 merge-gate verdict: **PASS — required fixes: none**.
