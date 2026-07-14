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
- After verification, select only high-similarity physical-product pairs and
  fetch at most six unique matched product pages per report for structured or
  contextual price evidence. Keep this enrichment separate from the pages used
  to verify competitor identity, enforce robots rules, and expose its coverage
  and failures.

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

The final exact no-retry production panel ran against private Sites version 24
from commit `9d26eac`. All ten submitted domains returned HTTP 200 market
reports and all ten separate ad-intelligence requests completed:

- 10/10 valid reports and 10/10 `GOOD` strict usefulness results;
- 10/10 correct regions with zero confident-wrong assignments;
- 10/10 domains with at least three accepted competitors, each supported by
  first-party category evidence and a positioning comparison;
- 9/10 domains with at least five non-generic products, plans, capabilities, or
  services (ustwo returned three first-party services);
- initial-report latency of 31.8 seconds p50 and 57.3 seconds p95;
- separate ad-intelligence latency of 19.5 seconds p50 and 24.7 seconds p95;
  and
- no retries, request failures, or discovery results discarded by a timed-out
  lane.

The panel was `myjam.co.uk`, `birdandblendtea.com`, `pipandnut.com`,
`oddbox.co.uk`, `beardbrand.com`, `allbirds.com`, `linear.app`, `buffer.com`,
`thoughtbot.com`, and `ustwo.com`. The former Allbirds failure returned HTTP
200 in 44.6 seconds with five verified competitors and 292 first-party product
records; its separate ad scan completed in 23.0 seconds. The first panel exposed
ten exact-page Meta placements for Pip & Nut through the configured provider,
but the second evidence capture did not reproduce that result and returned only
access-limited or no-verified-result states. The placement observation is
therefore historical, not a claim of current activity. Every other ad result
also remained an explicit official-search, access, or non-result state; the
report did not invent active campaigns or exact spend.

Because the first strict live-panel message was truncated, a second independent
no-retry evidence capture is preserved in
[`020-panel-v24-evidence.json`](./020-panel-v24-evidence.json). It includes every
accepted competitor with its verification score and first-party evidence URL,
five primary offering samples where available, up to five actual product-match
rows, and the Meta, Google, and TikTok status for the primary and each accepted
competitor. This second capture also returned 10/10 successful reports, 10/10
with at least three competitors, 9/10 with at least five primary offerings, and
10/10 completed ad scans. Its initial-report latency was 37.4 seconds p50 and
41.5 seconds p95; its separate ad phase was 19.9 seconds p50 and 31.6 seconds
p95. No credential is stored in the artifact.

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
- First live-panel review: Fable 5 returned `LIVE_PANEL_REVIEW: BLOCK`
  because the per-domain message was truncated and the private deployment
  returned HTTP 401 without Sites authorization. The aggregate score was not
  accepted as a substitute for inspecting the underlying rivals, offerings,
  and ad states.
- Resolution: the no-retry production panel was captured again and its reduced,
  secret-free public evidence was added as `020-panel-v24-evidence.json` for
  direct reviewer inspection.
- Second live-panel review: Fable 5 confirmed 10/10 rival credibility, 10/10
  regions, and the reliability fix, then returned `LIVE_PANEL_REVIEW: BLOCK`
  because no sampled pair exposed a comparable public price and the second ad
  capture did not reproduce the earlier Pip & Nut placements.
- Resolution: the ad record now distinguishes the historical first
  observation from the second capture, while a bounded six-page matched-product
  enrichment phase recovers price evidence without weakening competitor
  verification or silently expanding the crawl.
- Price-enrichment code review: Fable 5 returned
  `PRICE_ENRICHMENT_CODE_REVIEW: PASS` after tracing target selection, same-domain
  URL validation, robots enforcement, visible failure states, structured-price
  replacement, evidence citation, and the domain-identity regression fix. Fable
  independently ran 78/78 tests and lint successfully. Its two non-blocking
  follow-ups are region-aware `$` currency inference and avoiding one duplicate
  in-memory comparison build.
- Production price smoke: Sites version 25 returned two fetched enrichment pages
  for Pip & Nut and three for Bird & Blend. Bird & Blend produced exact public
  comparisons including Lemon & Ginger Tea (`GBP 7.75` versus `GBP 7.35`) and
  Perfect Matcha Spoon (`GBP 3.85` versus `GBP 4.50`). The same smoke exposed an
  invalid Peanut Butter-versus-Cookbook pairing before the final panel.
- Product-type resolution: accessory product-form groups now reject a food item
  paired with a book, mug, infuser, or other differently formed accessory while
  retaining like-for-like accessory comparisons. Singular/plural forms and
  near-synonyms such as mug/cup are normalized. Fable 5 returned
  `PRODUCT_TYPE_COMPATIBILITY_REVIEW: PASS`,
  `GROUPED_PRODUCT_TYPE_REVIEW: PASS`, and `RECIPE_BOX_FOLLOWUP: PASS`; the final
  local gate passed 79/79 tests, typecheck, build, and lint.
- Version 26 panel follow-up: all ten reports and all ten separate ad scans
  completed with public data. Nine reports returned at least three verified
  competitors; ustwo returned two. Seven reports returned at least five useful
  first-party offerings after generic labels were removed. The initial-report
  latency was 42.8 seconds p50 and 63.2 seconds p95; the separate ad phase was
  22.4 seconds p50 and 36.9 seconds p95. Every competitor retained first-party
  evidence, but the ad phase returned only access-limited or
  no-verified-result states and therefore made no current-activity claim.
- Price-integrity resolution: the version 26 evidence exposed misleading exact
  deltas when a product carried multiple variant or pack-size prices (for
  example, `GBP 3.49` and `GBP 7.85` compared with a rival `GBP 8.49` SKU).
  Exact price deltas are now emitted only when every observed price signal on
  each side resolves to one amount and both currencies match. Unresolved ranges
  remain visible but do not produce a cheaper/more-expensive percentage.
  Fable 5 first returned `VARIANT_PRICE_INTEGRITY_REVIEW: BLOCK` because the UI
  still selected the first raw price. After the UI was changed to consume only
  the server-approved pair, Fable independently reproduced the panel case,
  reran the gate, and returned `VARIANT_PRICE_INTEGRITY_REREVIEW: PASS`. The
  exact local gate passed 82/82 tests, typecheck, build, and lint.
- Production deployment: private Sites version 24 deployed commit `9d26eac` at
  `https://market-signal.abdulla617931.chatgpt.site/`; the final ten-domain
  panel above meets every acceptance gate.
- Merge remains blocked until Fable 5 returns a strict live-panel PASS, the
  final record is reviewed, and the exact merge candidate is deployed and
  verified.
