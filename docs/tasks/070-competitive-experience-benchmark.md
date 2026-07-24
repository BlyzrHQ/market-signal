# Task 070 — Competitive experience benchmark

## Outcome

Replace the generic live-report Overview with an evidence-grounded benchmark that shows how the submitted company compares with every verified rival on public shopping experience signals.

## User value

The first report view should answer four questions without requiring the user to inspect raw crawl output:

1. Where does my storefront lead or trail the market?
2. Is my public site slower to respond than verified rivals?
3. Are my products easier to find and better explained?
4. How much public friction is visible between a product and checkout?

## Evidence contract

- Persist an `experience-benchmark` block in each fresh report.
- Compare only the primary domain and verified competitor crawls from the same run.
- Store source URLs, observation time, sample sizes, raw values, score formulas, and coverage gaps.
- Call HTTP request duration a **crawl response proxy**, not Core Web Vitals or real-user page speed.
- Call checkout measurement an **observed public path estimate**, not checkout completion time. Never place an order or enter a private checkout.
- Call the image dimension **image readiness**. It may use product-image coverage, alt-text coverage, and responsive-image declarations; it must not claim subjective visual quality.
- Do not fill unknown values with zero. Unknown coverage must remain visible.

## Benchmark dimensions

- Crawl response: median HTML response time in milliseconds from this run, plus sampled-page count and payload size.
- Image readiness: product image coverage, meaningful alt-text coverage, and responsive/high-resolution markup coverage.
- Product information: average completeness of public product name, description, price, image, category, and quantity or identifier fields.
- Product access: public product links exposed from the homepage and whether a product/catalog path was reached in the bounded crawl.
- Purchase path: observed add-to-cart, cart, and checkout controls with the minimum public step estimate when defensible.
- Trust readiness: public shipping, returns/refund, contact, privacy/terms, and about/review paths.
- Mobile and accessibility basics: viewport metadata, document language, and image alt-text coverage.

## Presentation

- Rename the live-report Overview tab to Benchmark while preserving the terminal parked/unavailable status view.
- Lead with a grouped gap-to-market graph using the primary company, market median, and observed leader.
- Add an experience map plotting product access against product-information completeness.
- Show natural-unit comparisons for response milliseconds, image coverage, and public purchase steps.
- Rank only the largest evidence-backed opportunities and link each metric to its public source details.
- Keep formulas and limitations behind a concise disclosure instead of mixing methodology into the main decision surface.
- Support English and Arabic and avoid horizontal overflow.

## Acceptance criteria

1. Fresh reports contain a benchmark block for every crawled primary or verified competitor domain.
2. Failed or absent measurements render as unknown, never as a losing score.
3. Every score can be reproduced from persisted raw inputs and its documented formula.
4. The report contains no claim of Lighthouse, Core Web Vitals, visual image quality, or completed-checkout speed.
5. The benchmark has accessible text equivalents and remains usable without chart color.
6. Existing saved reports remain openable and explain that a new run is required when benchmark evidence is absent.
7. Automated tests cover metric formulas, unknown handling, report persistence, routing, and responsive presentation.
8. At least one fresh real public-domain run is inspected before release.

## Fable review

Fable 5 (`claude-fable-5`) completed a strict review on 2026-07-24 and
returned `FAIL` with two blockers:

1. The add-to-cart detector could mistake `name="address"` and similar contact
   fields for an observed purchase control.
2. Image readiness and mobile/accessibility converted unobserved image markup
   into zero-valued score components.

Both blockers were fixed with regression tests. Add-to-cart detection now
requires an exact attributable cart/bag/basket control signal. Composite scores
are normalized only across components observed in the crawl; their persisted
formula strings disclose that behavior.

The review also identified a paid market-brief phase whose result was no longer
rendered after the benchmark replaced Overview. Fresh orchestration no longer
calls that phase and persists `marketBrief: null`; the API surface remains
available for older clients while new reports avoid the unused model cost.
The experience-map coordinate system is now physically left-to-right in both
locales so the Arabic “easier access” axis label remains on the increasing end.

Strict re-review remains required before merge.

## Validation

- TypeScript check: passed.
- Production build: passed.
- ESLint: passed with the two pre-existing `no-img-element` warnings and no errors.
- Automated suite after the Fable blocker fixes: 342/342 tests passed.
- Fresh public MyJam crawl after the final product-page crawl priority: 602 public products; 459 ms median crawl-response proxy; image readiness 79; product-information completeness 67; product access 100; public purchase-path score 75 with an observed minimum two-step estimate; trust readiness 20; mobile/accessibility basics 85. The five sampled pages included the homepage and four public product pages.
- A fresh Al Hamdani Sweets check demonstrated materially different evidence rather than fixed output: 51 products; 519 ms response proxy; image readiness 100; information 70; product access 100; purchase-path score 75 with a two-step public estimate; trust 40; mobile/accessibility 100. Its five sampled pages included the homepage and four public product pages.
- Babanuj produced one successful preliminary measurement, then a later request returned HTTP 403. The final validation records the latter as a crawl availability change rather than reusing stale metrics.
- `noororganic.com` returned the existing typed HTTP 409 limited state and produced no benchmark score.
- In-app visual QA is still pending. The browser controller failed during setup with a missing local kernel-assets path; no visual-pass claim has been made.
