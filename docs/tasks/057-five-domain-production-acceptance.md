# Task 057 - Five-domain production acceptance

## Goal

Prove that the deployed, durable Market Signal workflow returns useful and truthful competitive intelligence for five real public ecommerce domains, one run at a time. Treat any missed publicly available product data, false competitor, unsafe product match, invented ad claim, or silent coverage gap as a defect to fix before continuing.

## Domain sequence

1. `myjam.co.uk` - production anchor and regression check.
2. `babanuj.com` - bilingual catalog and known product-enrichment stress case.
3. `noororganic.com` - prior crawl-failure regression case.
4. `al-hamdanisweets.com` - Arabic/RTL catalog stress case.
5. `baklali.app` - truthful degradation case if no attributable public catalog exists.
6. Re-run `myjam.co.uk` after any implementation changes to confirm the anchor did not regress.

The domains are intentionally concentrated in food and cultural ecommerce because the user can judge competitor and product truth in this market. SaaS-plan and agency-offering production coverage remains a follow-on task.

## Per-domain mechanical gate

- `POST /api/reports` returns HTTP 202 with a public report ID and Trigger run ID.
- The persisted run reaches `complete` or truthfully `limited` within 20 minutes.
- Event sequence is monotonic, phase transitions are bracketed, and idempotency keys do not conflict.
- A healthy run does not become stale, interrupted, or stuck queued.
- No closed internal diagnostic code is emitted by the Worker.

## PASS criteria

1. Competitors: at least two score-55-or-higher candidates are manually confirmed as genuine same-market rivals, with no false entry presented as verified. Recall is recorded but not graded because there is no complete market ground truth.
2. Products: at least five matched rows are produced. Five sampled verdicts are defensible; three sampled prices match same-day public product pages; images use HTTPS and depict the correct products. A price delta appears only when currency and variant alignment are proven.
3. Ads: each verified company/platform has an honest observed, unavailable, or no-attributable-record state. The report never equates an unchecked source with “no ads.”
4. Provenance: every material claim includes a source URL and observation time. Unmatched products and coverage gaps remain visible.
5. Anti-dump check: from the rendered report alone, a reviewer can answer within ten minutes: who are the top two rivals; where is one evidenced product price advantage or disadvantage; and what is one recommended action. Every answer traces to a source.

## LIMITED criteria

`limited` is acceptable only for an environmental source restriction or genuinely non-public data. Every displayed item must still pass the precision checks and the report must label the gap and reason. If the public site visibly exposes data that Market Signal misses, the run is a FAIL and requires a focused implementation fix.

For `baklali.app`, honest degradation passes when the crawl succeeds, states that no attributable catalog or market evidence was found, shows what was actually verified, and invents nothing.

## FAIL criteria

- A false or unsupported competitor, product match, price delta, image, or ad claim.
- A public Shopify/WooCommerce price or image is available but omitted.
- Broken, HTTP, or wrong-product imagery.
- A failed section is silently absent instead of represented as a coverage gap.
- The mechanical gate or anti-dump check fails.
- The same internal gap occurs on three or more domains; this is a matrix-level systemic blocker even if each report labels it honestly.

## Evidence captured per run

- Public report ID, Trigger run ID, timestamps, attempt count, terminal status, and document byte size.
- Ordered events with sequence, idempotency key, phase, status, and observed time.
- Competitor domain, verification score, role, and manual legitimacy verdict.
- Catalog/enrichment coverage, matching method, assigned and verified pair counts, and truncation/gap reasons.
- Five sampled product rows with verdict, current public price check, image check, and source URLs.
- Ads state per company/platform with evidence URLs and explicit coverage limitation.
- The three anti-dump answers with source links.
- A browser screenshot and checks for secure images, source-link resolution, dashboard navigation, loading-to-report transition, layout/overflow, and Arabic/RTL rendering where relevant.

## Execution rule

Run one domain, evaluate it, fix and re-review any defect, deploy the exact verified commit, and re-run the affected domain before starting the next. Do not dispatch all five together. After all five, re-run MyJam as the regression anchor.

## Fable 5 design review

Fable 5 returned `TASK 57 ACCEPTANCE DESIGN: PASS`. It approved the domain set and sequence, required precision and human usefulness over raw block counts, distinguished environmental limitations from extraction defects, defined honest ad-coverage states, and added the matrix-level systemic-blocker rule.

## Results

Pending sequential production validation.
