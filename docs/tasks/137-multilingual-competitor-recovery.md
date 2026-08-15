# Task 137 — multilingual competitor recovery

## Problem

Real storefronts can expose healthy catalogs while returning no competitors. The production Noor run on 2026-08-15 persisted 242 first-party products, 242 images, and 80 priced products, but discovered zero rivals. The broader twenty-brand baseline also found six completed reports with zero verified competitors.

The product-search lane rejected a search result before first-party crawling unless its URL used a small English product-path vocabulary and repeated enough product-name tokens in the path. This excludes localized paths such as `/produkt/...`, Magento-style `.html` pages, and ID-based product URLs even when the search-result title strongly identifies the product.

## Decision

Keep `isProductDetailSource` as a high-confidence signal, but do not make it the only admission path. A product-search source may enter the bounded candidate set when:

- the existing title-and-URL matcher identifies at least two product terms with at least 50% shared-token coverage, and title-only admission covers more than half of the primary product identity terms;
- the source is on a different non-marketplace company domain;
- the URL is non-root and is not a publisher/editorial path; and
- the source does not contain the primary brand identity.

Title-only admissions are explicitly described in the candidate reason. The six-candidate cap, first-party crawl, entity verification, ecommerce product-overlap requirement, region checks, and finite positive supported-currency rival-price publication gate remain unchanged.

## Scope

- Demote the English URL-shape heuristic from hard rejection to a confidence signal at both product-lane admission points.
- Add focused regression tests for localized, `.html`, and ID-only product paths and for retained rejection boundaries.
- Do not lower verification or publication thresholds.
- Do not claim full CJK parity; languages without whitespace segmentation remain a documented follow-up.

## Validation

- Focused competitor-discovery and verification tests.
- Full typecheck, node typecheck, production build, test suite, and lint.
- Strict Fable 5 review on the exact PR head.
- Trigger deployment before VPS deployment of the exact approved merge commit.
- Fresh public-domain validation must retain zero source/price-integrity violations and produce at least one verified, priced rival comparison for the recovery anchor or record the remaining data-quality state without overclaiming.

## Evaluation follow-up

After deployment, run a fresh 20-domain matrix spanning multiple niches, languages, and scripts. Rate each report separately for execution, first-party catalog coverage, verified competitor recall, priced product usefulness, evidence integrity, and human usefulness. Preserve failed and limited results rather than converting unknowns to zero.
