# Task 024 — Close the integration evidence gates

## User problem

The combined competitor-discovery, product-comparison, and ad-intelligence work
is deployed, but the final merge cannot rely only on component tests. The last
recorded ten-domain usefulness panel predates the later product and ad work and
failed its usefulness threshold. Arabic/RTL and narrow-screen overflow also
need a rendered-screen check.

## Scope

- Run the unchanged ten-domain production panel against the exact Sites version
  38 integration commit, once per domain and without retries.
- Record reduced, secret-free evidence for competitors, offerings, product
  matches, exact comparable prices, ad states, regions, and latency.
- Have Fable 5 independently score the evidence against Task 020's existing
  acceptance gate.
- Visually inspect one real MyJam report in English and Arabic at narrow,
  tablet, and desktop widths, recording viewport overflow and RTL behavior.
- Do not change product code unless the live panel or visual pass exposes a
  concrete defect.

## Acceptance criteria

1. All ten production requests target Sites version 38, commit
   `82c4f782af299661f8d3eb3059e8da3346f74af9`, with no fixture data and no
   retries.
2. At least 7/10 domains return three credible same-category competitors.
3. At least 9/10 inferred regions are correct with zero confident-wrong regions.
4. At least 8/10 domains expose five non-generic offerings.
5. Every verified-competitor report has a useful product/service comparison or
   a cited positioning comparison.
6. Discovery timeout failures are at most 1/10 and do not erase completed lanes.
7. Fable's strict median usefulness score is at least 70 with at least 7/10
   `GOOD` reports.
8. Production crawl p95 is at most 90 seconds.
9. A rendered MyJam report shows no horizontal page overflow at approximately
   360px, 700px, and desktop widths in English and Arabic; Arabic correctly
   switches the document to RTL.
10. The evidence artifact contains no credentials or private authentication
    material.

## Data boundaries

- The panel records only public-source results returned by the deployed app.
- Missing ad evidence remains an access/coverage state, not a claim of zero
  advertising.
- Deterministic local scores are diagnostic only. Fable 5's independent strict
  content review is the merge gate.
- A visual pass verifies layout behavior; it does not upgrade the confidence of
  market or ad claims.

## Validation record

- Sites version 38 baseline (2026-07-14, no retries): 10/10 reports and ad
  scans returned, region 10/10, crawl p95 54.6 seconds, but only 5/10 reports
  scored `GOOD` and the median diagnostic usefulness score was 69.5. The
  secret-free reduced evidence is `024-live-panel-v38.json`.
- Fable 5 strict baseline review: `PANEL_V38_BLOCKERS`. It identified one
  same-brand storefront (`birdandblendtea.us`), one review publisher
  (`which.co.uk`), a duplicate-homepage crawl slot, a generic
  `Social media <> Social Media` comparison, and the still-pending rendered
  EN/AR responsive check.
- Implemented four regression fixes with red/green tests: hostname-aware
  same-brand exclusion, model-candidate publisher-path rejection, root seed
  removal from competitor expansion, and business-type-only offering removal.
- Local gate after fixes: typecheck passed, production build passed, 101/101
  tests passed, and ESLint passed.
- Patched production panel and rendered EN/AR responsive validation: pending.
