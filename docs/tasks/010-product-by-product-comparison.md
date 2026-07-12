# Task 010: product-by-product comparison

## Goal

Show every publicly observed product or service from the submitted company beside the closest publicly observed product from each submitted competitor. The comparison must be useful without claiming two products are equivalent when the evidence only supports a possible match.

## Proposed collection

- Keep the existing bounded crawl: up to 4 domains and 5 HTML pages per domain.
- Prefer observed sitemap/internal paths containing product, shop, store, collection, catalog, pricing, plan, solution, service, platform, or feature signals.
- Extract structured `Product`, `SoftwareApplication`, and `Service` records from JSON-LD.
- Apply an ownership guard before catalog inclusion: accept structured records only when their brand, manufacturer, or provider resolves to the crawled domain identity. If ownership metadata is absent, structured records require a product-like path. Third-party-branded records are classified `third-party-referenced` and excluded from the company's comparison rows.
- When no structured record exists, derive one only when the URL has a product/shop/store/catalog/collection/pricing/plan/solution/service/platform/feature path signal and the page also exposes a public price or at least two product/plan/feature headings. A shallow branded path such as `/billing` may also qualify when the page title contains the domain identity, at least three substantive headings exist, and the path is not company/content/support/legal material. Label the extraction method `page-signal` with Medium confidence.
- Store product name, description, category, public price signals, observed attributes, source URL, observed timestamp, extraction method, confidence, and claim IDs.
- Never manufacture a product from a homepage, generic article, or model output.

## Proposed comparison

- Primary-domain products define the rows.
- Each comparison domain defines a column.
- Match deterministically using normalized name/category/description token overlap.
- Weight name tokens 3x, category tokens 2x, and description tokens 1x; remove generic commerce/SaaS terms before scoring.
- Require a score of at least 0.35 and at least one shared non-generic name token. Use a deterministic one-to-one greedy assignment per competitor so one competitor product cannot fill multiple rows.
- Never match a physical `Product` to a `Service` without category overlap.
- Label matches `Inferred` and “closest observed match,” never “equivalent.”
- Include match score, confidence, shared terms, public price signals, attributes, and direct evidence links.
- Show “No comparable public product observed” when the threshold is not met.
- Show unmatched competitor products in their own evidence-backed list.
- If no primary products are found, render an explicit product-coverage gap instead of an empty or fabricated comparison.

## Acceptance criteria

- A JSON-LD product becomes an observed catalog record with a resolvable evidence claim.
- A clearly product-like page can become a Medium-confidence `page-signal` record.
- Generic homepages and blog pages do not become products.
- Third-party-branded JSON-LD records do not enter the submitted domain's own catalog.
- Every rendered product and closest match links to its observed source.
- Every inferred match has a score, confidence, shared terms, and both product claim IDs.
- Low-similarity products render as unmatched rather than forced matches.
- Generic-only overlaps such as “Pro Plan” versus “Pro Suite” remain unmatched.
- Matching is deterministic and one-to-one within each competitor column.
- The JSON report renders product catalogs, comparison rows, unmatched items, and coverage gaps without fixtures.
- Real multi-domain validation, build, lint, tests, strict Fable 5 review, draft PR, and private Sites deployment all pass.
- Pure exported extraction and matching functions have behavioral unit tests covering JSON-LD object/array/`@graph`, malformed JSON-LD, ownership, negative pages, page signals, thresholds, and one-to-one assignment.

## Boundaries

This release compares only products visible within the bounded public crawl. It is not a complete catalog guarantee. Variants, inventory, regional pricing, authenticated catalogs, JavaScript-only content, and products outside the five-page budget remain visible coverage limitations.

## Fable 5 design review

Final strict code verdict: PASS. Fable 5 reproduced and required fixes for generic shallow-page fabrication, confidence-downgrading deduplication, and product-panel mojibake. The final revision uses a product-path allowlist plus positive page evidence, preserves High structured evidence, rejects adversarial generic paths, and contains no unresolved reviewer blockers.

Initial verdict: BLOCKED. The reviewer required the ownership guard and behavioral tests above before implementation. It also required explicit product-block renderer branches, defensive JSON-LD parsing, generic-token suppression, and visible “from N scanned pages” coverage wording. These requirements are incorporated into this task and are release gates.

## Validation evidence

- Full suite: 13 tests pass. The 11 product-intelligence tests cover JSON-LD object/array/`@graph`, offer variants, third-party ownership exclusion, generic-page negatives (including `/customers` and `/jobs`), branded shallow product pages, malformed JSON-LD, confidence-preserving deduplication, generic-only matching rejection, deterministic scoring, and one-to-one assignment.
- Live SaaS comparison on the rebuilt production server: `chargebee.com` produced 8 attributable products across 5 pages, `recurly.com` produced 3 across 4 pages, and `paddle.com` produced 4 across 5 pages. The eight primary-product rows contained one evidence-qualified match and refused weaker pairings.
- Evidence invariant: 46 product-related claim references resolved to evidence blocks; unresolved product claims: 0.
- Negative live case: `nytimes.com` produced 0 products and an explicit product-coverage gap.
