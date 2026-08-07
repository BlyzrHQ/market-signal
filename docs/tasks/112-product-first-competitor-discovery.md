# Task 112 — Product-first competitor discovery

## Goal

For ecommerce reports, discover competitors from sellers of comparable products rather than filling the competitor list from company/category searches first.

## Decision

1. Crawl and extract the submitted company's attributable public catalog.
2. Select a bounded, diverse set of representative products.
3. Search those product names in the inferred region and retain only attributable seller product-detail pages.
4. Group the product results by canonical seller domain and rank sellers by distinct matched products and evidence coverage.
5. Crawl and verify those sellers as competitors. Ecommerce competitors must expose a defensible product overlap in their current first-party crawl.
6. Run company/category discovery only when product search produces no attributable seller. These leads remain subject to the same product-overlap verification and the report records that fallback.
7. Preserve company-first discovery for SaaS, agencies, and sites without an attributable ecommerce catalog.

## Acceptance criteria

- Ecommerce product searches finish before any company/category fallback begins.
- A successful product search prevents company-first candidates from consuming the six investigation slots.
- Multiple matched products from one seller are merged into one candidate with distinct product evidence.
- Product-backed sellers rank ahead of category-only leads.
- Ecommerce candidates without a verified current product overlap are rejected.
- Search failures and fallback use remain visible as coverage gaps.
- Focused tests, the full test/build/lint gate, a strict review, and a real-domain validation pass before merge.

## Review state

Claude/Fable architecture review was requested before implementation but could not start because the local Claude OAuth session had expired. After authentication was restored, verified Claude Fable 5 reviewed the exact PR patch and returned `FABLE_GATE: BLOCK`. It found that the discovery-exception path reset ecommerce to `unknown`, allowing remembered sellers to bypass product-overlap verification, and that the route wiring lacked a regression test. The route now derives an immutable policy from the primary crawl before discovery, uses it after discovery failure and during all remembered/fallback verification, and has a route-level regression proving a stale remembered seller is rejected and selected for forgetting. Fable also requested more precise fallback wording; completed-empty searches are now distinguished from failed/incomplete product searches. A strict re-review remains required.

## Validation

- Focused product-discovery and verification tests: 38/38 passed.
- Repository test gate after the Fable blocker fixes: 526/526 passed.
- Production build and lint passed; lint retained two pre-existing `<img>` optimization warnings and no errors.
- Real public-product probe on 2026-08-07: the deterministic evidence filter accepted `anteplie.co.uk/products/traditional-turkish-square-pistachio-baklava` for a Pistachio Baklava anchor and `cateringsupply.co.uk/products/walnut-baklava-1kg` for a Walnut Baklava 1kg anchor, while rejecting a Reddit discussion URL. This validates source attribution and product-detail filtering, not the undeployed end-to-end report.
- End-to-end production report validation remains pending review, merge, and deployment.
