# Task 020: Entity-first competitor discovery

## Problem

The production ten-domain panel returned valid live data for every request, but
zero reports met the product usefulness gate. Competitor discovery is currently
a single product-name-first web-search request with a 40-second all-or-nothing
timeout. It rejects candidates unless a fetched rival product has lexical
overlap and the existing prose-regex region detector agrees.

This caused:

- discovery timeouts to erase the entire market for MyJam and Pip & Nut;
- zero competitors for obvious markets such as Allbirds, Linear, and Buffer;
- accessory sellers to appear as tea-company competitors;
- confident wrong regions for Bird & Blend and thoughtbot;
- empty or generic catalogs for subscriptions, SaaS, and agencies; and
- prose numbers to be presented as Linear pricing.

## Outcome

Move to an entity-first pipeline:

1. infer an evidence-backed business and market profile from the primary site;
2. run independent entity, category, and optional product search lanes;
3. retain partial results when any lane times out;
4. crawl candidate companies and verify category alignment from their own site;
5. treat product overlap as supporting evidence, not the definition of a
   competitor; and
6. provide an evidence-cited positioning comparison when exact product rows are
   unavailable.

## Data boundaries

- Every competitor requires at least one attributable public evidence URL.
- Search results remain inferred until the candidate's public site is crawled.
- Region assignments expose their observed signals and confidence.
- Unknown region is neutral; a proven mismatch remains a rejection signal.
- Product prices require structured or price-context evidence.
- Advertising limitations and non-results remain explicit.
- No credentials or fixture results may enter customer reports.

## Implementation

- Add weighted region inference using ccTLD, language, structured address,
  currency, phone, and explicit market signals.
- Add business-profile inference for ecommerce, SaaS, agency, and unknown sites.
- Replace the monolithic discovery request with independently timed search
  lanes aggregated through partial success.
- Extend candidates with entity category, relationship, overlap, and evidence.
- Verify competitors by category alignment, independence, region compatibility,
  and optional offering overlap.
- Add service/plan/catalog fallbacks and suppress prose-derived prices.
- Add entity-positioning evidence to competitor report blocks and UI dossiers.
- Split accepted-company ad intelligence into a second visible report phase so
  the verified market and product result is not lost when an ad provider is
  slow. The UI must distinguish scanning, unverified, and not-scanned states.
- Keep the primary crawl at five representative HTML pages and four sitemap
  documents. Bound each discovered-company verification crawl to three HTML
  pages and two sitemap documents, and expose the role-specific limits in
  coverage metadata.

## Validation

- Offline regression tests cover partial search failure, evidence invariants,
  accessory rejection, unknown-region neutrality, region weighting, plan/service
  extraction, sitemap variants, and prose-price suppression.
- Run typecheck, production build, all tests, lint, and diff checks.
- Strict Fable 5 architecture decision: `ARCHITECTURE_GATE: PASS`.
- Strict Fable 5 code review must return PASS before deployment.
- Deploy the exact reviewed commit privately and rerun the same ten-domain panel.

The first exact no-retry production run on commit `b04af1b` returned useful
reports for 9/10 domains, but `allbirds.com` ended in a hosting HTTP 500 after
62.9 seconds. Successful requests still took 41.3–80.7 seconds. This run is a
failed reliability gate and is retained as evidence for the staged-report fix;
it is not counted as completion.

## Acceptance gate

- At least 7/10 domains return three credible same-category competitors.
- At least 9/10 regions are correct with zero confident-wrong assignments.
- At least 8/10 domains expose five non-generic product/service records.
- Every verified-competitor report has meaningful product rows or a cited
  positioning comparison.
- Discovery timeout failures are at most 1/10 and never discard completed lanes.
- Median strict usefulness score is at least 70 with at least 7/10 GOOD.
- Production p95 remains at or below 90 seconds.

## Review record

- Architecture review: the verified interactive Fable 5 session returned `ARCHITECTURE_GATE: PASS` for entity-first lanes, first-party verification, neutral unknown regions, and a company-level comparison fallback.
- First code review: Fable 5 blocked a product-overlap path that could admit a same-region accessory seller.
- Resolution: category alignment now requires at least two non-generic terms shared by the companies' own core descriptions. Product overlap can raise confidence but cannot establish competitor status. A same-region tea-shop-versus-mug-shop regression test covers the former bypass.
- Final code review: Fable 5 returned `CODE_REVIEW: PASS` after inspecting the revised diff and independently running 63 tests plus lint.
- Follow-up content review: Fable 5 returned `FOLLOWUP_REVIEW: PASS`; the local gate then passed 69 tests, build, and lint.
- Generic-offering cleanup review: Fable 5 returned `FINAL_CLEANUP_REVIEW: PASS`; the exact local gate passed 72 tests, build, and lint before Sites version 23.
- Performance design review: Fable 5 returned `PERFORMANCE_DESIGN: BLOCK` for speculative pre-verification ad scans because rejected candidates could consume the company cap and create false ad non-results. That design was discarded.
- Staged-flow review: Fable 5 returned `STAGED_CODE_REVIEW: PASS` after verifying that ad requests contain only the primary and accepted competitors, the seven-company cap covers primary plus all six candidates, private/local domains are rejected, and the UI exposes scanning versus not-scanned states. Fable independently ran 74 tests and lint successfully.
- Merge remains blocked until the exact commit is deployed and the ten-site live quality gate above is recorded.
