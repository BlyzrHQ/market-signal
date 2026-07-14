# Task 022: Product-backed comparison pillar

## Customer problem

The report can confirm legitimate company-level competitors while still producing zero product comparisons. For MyJam, the primary crawl exposed hundreds of products, but broad competitor discovery returned seller homepages or shallow catalogs instead of exact comparable product pages. Valid pairs were then hidden inside collapsed rival dossiers.

## Product decision

Market Signal has three report pillars: competitors, product comparison, and ads. This task owns only the product-comparison pillar. Company-level competitor discovery remains intact.

For ecommerce reports, product discovery must search individual representative products and recover first-party seller product-detail pages from current public search evidence. A seller may enter the product-comparison set only when a deterministic name/path check connects its page to a primary product. Exact URLs seed the seller crawl. At least two investigation slots remain reserved for entity/category candidates. Product-backed candidates rank ahead only after the seller crawl passes category, region, and entity verification and proves a product pair.

The report must show defensible pairs in a dedicated top-level Product Comparison chapter. A truthful coverage state must appear when searches complete without a defensible pair.

## Acceptance criteria

- Run bounded product-specific searches for a diverse, deterministic set of primary ecommerce products.
- Prefer structured or price-bearing anchors, reject generic/accessory anchors, use distinct product families, cap anchors at four, and cap total discovery calls at six.
- Search requests target one named product at a time and request exact first-party product-detail pages in the inferred region.
- Reject the primary domain, social networks, publishers, directories, unsafe URLs, homepages, category pages, and weak one-term overlaps.
- Reject known marketplaces/aggregators and pages that repeat the primary brand as likely retail-channel/stockist results.
- Require a product-detail path and either three shared non-generic terms or two terms covering at least 60% of the anchor name.
- Keep each accepted source URL, search query, matched primary product, evidence method, and observed crawl evidence attributable.
- Reserve two candidate investigations for direct entity/category leads; rank product-backed companies first only after strict first-party category, region, and product-overlap verification.
- Seed no more than two accepted product-detail URLs into the corresponding competitor crawl; always retain the homepage and robots checks.
- Render a universal top-level Product Comparison chapter with the matched names, public prices when observed, decision guidance, match evidence, observed dates, confidence, rival-dossier link, and links to both product sources.
- Show at most eight pairs initially, retain an accurate total, and place additional verified pairs behind an explicit expander.
- Clearly state when no defensible pair was verified; never manufacture a pair or present fixture data as live.
- Add regression tests for exact-source recovery, weak/homepage rejection, ranking, bounded requests, and top-level rendering.
- Validate against `myjam.co.uk` and record the observed live sources and coverage.
- Pass typecheck, build, lint, automated tests, strict Fable 5 review, PR checks, and private deployment verification before merge.

## Data-source boundary

Search results are discovery leads, not product truth. Product names, prices, descriptions, and images shown in the comparison must come from the crawled first-party pages. Search evidence may identify the page but cannot supply unsupported price or product claims.

## Known limits

- The search set is deliberately bounded for latency and cost; it is not an exhaustive comparison of every SKU in the first run.
- Robots rules, dynamic storefronts, unavailable product pages, and regional variants can prevent verification.
- Image similarity is supporting evidence only and does not override a weak product-name match.

## Fable 5 pre-implementation review

Fable 5 returned `BLOCK` on the initial direction. Required changes B1-B7 were accepted: marketplace exclusion, same-brand stockist exclusion, two reserved entity slots, stronger overlap and product-path gates, two seeded paths per domain, six total parallel discovery calls, and a bounded universal Product Comparison chapter that preserves SaaS/Arabic behavior.

After the task plan was updated, the verified Fable 5 session returned `PRODUCT_BACKED_COMPARISON_PLAN_REVIEW: PASS`. It retained three implementation-review checks: measure live latency, explicitly preserve SaaS/Arabic/deep-link behavior, and reuse the single `isDefensibleProductMatch` threshold. This is a plan verdict only; the implementation still requires a fresh strict review after live validation.

## Local validation

- `npm.cmd test`: PASS (typecheck, production build, 94 tests)
- `npm.cmd run lint`: PASS
- `git diff --check`: PASS
