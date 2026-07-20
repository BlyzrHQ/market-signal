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

### 1. MyJam anchor

- Initial report `0b98cfda042b4748869c03cd5ecd2e01` passed the mechanical, competitor, matching-volume, and ad-truthfulness gates but failed price integrity: E-Grocers exposed an unset WooCommerce zero sentinel that was rendered as `GBP 0`.
- Focused Task 58 fixed the adapter, passed strict Fable 5 review, and was deployed as Sites version 97.
- Corrected report `17f5f5377b404e82b2f0a95e3788e06d` (Trigger run `run_06fo0j9lvde1rn0r4jm7kef901`) persisted 4 verified competitors, 600 primary products, 2,060 rival products, 30 verified pairs, and zero zero-or-negative catalog price signals. Browser QA found 30 rows, 60/60 loaded images, and no false zero-price labels.
- The corrected report is truthfully `LIMITED`: 24 selected AI assessments reached the bounded deadline and were left unaccepted. This is retained for the final anchor assessment.

### 2. Babanuj

- Report `fdfd44afa3154b70897092095171ae82` (Trigger run `run_06fo0mk9e0ut9nch684eamdd01`) completed with 13 events, 6 displayed competitors, 71 primary products, 1,363 rival products, 16 verified pairs, and 22 enriched pages.
- Product evidence was materially useful: same-product Zaitoune maamoul and baklava rows retained current public prices and secure imagery, and cross-currency rows correctly withheld direct price deltas.
- Result: `FAIL` pending a focused fix. The report inferred the United States but marked `desertcart.in` and `desertcart.com.sa` as region-compatible competitors. Those country storefronts are not same-market US rivals and created cross-market rows plus avoidable enrichment gaps.
- Focused Task 59 corrected target-market precedence, added bounded fulfillment-origin inference, and preserved observed country-code storefront evidence ahead of diluted combined page signals. Fable 5 returned strict `PASS`, independently reran all `280/280` tests and lint, and merged PR #59 as `5515e4e` after Sites version 100 passed the live gate.
- Corrected report `c697d2c98adb47ed9c56c9d78c214105` completed with a United States market, five verified competitors, four with product overlap, 62 assessed primary products, and 17 accepted product battles. No India, Saudi Arabia, or Egypt Desertcart storefront appeared as a verified competitor; discovered `desertcart.com.eg` remained visible as an investigation gap with target, ccTLD, first-party provenance, and combined-signal outcome.
- Browser QA found all 17 saved product rows, 27/27 loaded images, zero broken images, seven dual-price rows, seven single-price rows, and three rows with no observed price. Missing prices were labeled and no unsupported direct price delta was rendered. Ads checked all six companies and honestly reported zero verified active signals and three access-limited checks as not proof of zero ads.
- Corrected result: `PASS` for competitor precision, product usefulness, provenance, image integrity, and ad truthfulness. Continue to `noororganic.com`.

### 3. Noor Organic

- Fresh report `0a54c2b196fe450ea8a32dd20191d3d7` (Trigger run `run_06fo1vf7i7o45eitf9hhcvu801`) reached terminal `LIMITED` on attempt 1 after the primary crawl identified `noororganic.com` as a parked HugeDomains property. The parking evidence resolves to `https://noororganic.com/lander`.
- The bounded path emitted the canonical sequence `run-created`, `job-dispatched-attempt-1`, `crawl-started`, `crawl-limited`, `brief-limited`, `ads-limited`, `matching-limited`, and `report-saved`. It performed no competitor discovery, catalog extraction, ad lookup, or product matching against an identity that could not be verified.
- The saved report contains only source-backed domain status, summary, coverage, and investigation-gap blocks. `noororganicfood.com` and `noororganicoil.com` remain explicitly labeled as possible domains with identity not verified; neither is presented as the submitted company or as a competitor.
- Browser QA on Sites version 101 showed only Overview, Evidence, and Methodology navigation; the page states that the domain is parked, that competitors/products/ads were not checked, and that this is not a zero-result report. The source link and both unverified alternatives render without horizontal overflow.
- Task 60 passed strict Fable 5 review after its retry-idempotency blocker was fixed. Fable independently reproduced all `286/286` tests, confirmed the exact reviewed/deployed tree, returned `FINAL PASS`, and merged PR #60 as `bda7c29` after the live Sites and Trigger verification.
- Result: truthful `LIMITED` acceptance. The prior generic public-crawl failure is fixed; no unsupported market intelligence is produced for a parked primary identity. Continue to `al-hamdanisweets.com`.
