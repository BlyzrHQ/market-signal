# Task 061 - Shopify primary-product price recovery

## Problem

The fresh Al-Hamdani production report `464c808aa9eb464898301a8e7b4f01e0` collected 51 first-party Shopify products and their secure images, but persisted no structured product prices. The crawl currently enriches product pages only after competitor pairs exist. When competitor discovery times out, the primary catalog therefore cannot recover prices even when the same-domain public Shopify product endpoint exposes them.

The overview also repeated an unstructured `$0` page pattern. That number was not attributed to a product offer and must not be presented as pricing evidence.

## Outcome

Recover a bounded sample of attributable primary-product prices before competitor matching, using the existing identity-gated storefront adapters. Preserve ambiguity when a product has multiple variants so no direct price delta is calculated without a single aligned amount and currency.

## Proposed behavior

- Select at most six first-party primary `Product` URLs that lack comparable structured prices.
- Respect robots directives and the existing same-domain redirect boundary.
- Fetch the public product HTML to confirm a same-page ISO currency, then fetch the exact same-domain Shopify or WooCommerce public adapter endpoint.
- Require endpoint handle/slug identity and product-page identity to agree with the sitemap product before merging the enriched record.
- Keep multiple observed variant prices when no exact variant quantity is known. The existing comparison decision must continue to withhold a direct delta when more than one amount remains.
- Persist pre-match requested/fetched counts under fields distinct from matched-pair enrichment and add a source-linked gap for each blocked, unavailable, identity-conflicting, or currency-unconfirmed attempt.
- Remove zero-valued unstructured page price patterns from page-level claims and market-brief input. Keep the unfiltered observations available to region inference, and do not change structured Shopify zero behavior or SaaS free-plan extraction in this task.
- Do not change competitor discovery, product matching, or ad coverage in this task.

## Acceptance criteria

- An Al-Hamdani-shaped Shopify product returns its public USD variant prices and secure image through the bounded primary enrichment path.
- The path never requests more than six products and never follows an off-domain redirect.
- Robots denial, missing currency, invalid endpoint payload, and product identity mismatch retain the sitemap product and expose an explicit gap.
- Multiple Shopify variants remain non-comparable as a direct price delta until a variant or quantity is aligned.
- `$0`, `USD 0`, and equivalent zero-valued unstructured page patterns are absent from crawl claims and the market brief; positive values including `$0.99` and `EUR 0.50` remain, and existing region-currency inference is unchanged.
- Existing structured Shopify zero, WooCommerce sentinel, SaaS free-plan, product adapter, matching, crawl, report, typecheck, lint, and production-build tests remain green.
- A live Al-Hamdani adapter check proves the source endpoint and currency evidence. The exact reviewed commit is deployed to Sites and Trigger and a fresh production report is inspected before merge.

## Data truth boundary

Storefront endpoints are used only when they are public, same-domain, robots-permitted, and tied to the expected product identity. A list of variant prices is evidence that prices exist, not evidence that any one variant is directly comparable to a rival. Raw page numbers are not product prices without attributable structured context.

## Review record

Fable 5 returned `TASK 61 DESIGN: PASS`. It confirmed that this reuses the existing robots, same-domain redirect, identity, adapter, and multi-variant delta gates. It required distinct coverage labels for pre-match enrichment and required the zero filter to leave region inference and positive sub-unit values unchanged.

Fable 5's first strict implementation review returned `TASK 61 IMPLEMENTATION: BLOCK` because the shared API parser had accidentally narrowed existing HTML-only `/shop/` and `/store/` enrichment targets to adapter-capable URLs. The existing same-domain product-path boundary was restored for `/api/enrich-products`, while the new primary selector remains deliberately adapter-only. A regression test now proves a same-domain `/shop/` target is counted, fetched, identity-gated, and enriched from public HTML.

Fable 5's strict re-review returned `TASK 61 IMPLEMENTATION: PASS`. It verified that the existing API boundary is restored, the primary selector remains adapter-only, the new `/shop/` regression test covers the previously silent loss, and the full 295-test suite plus typecheck, production build, and lint remain green (one pre-existing lint warning, no errors).

## Production validation

- Exact source commit: `bbacdd18afb8c3dbb2c5f63bee00599750dbe4a5`.
- Sites version 102 deployed successfully at `https://market-signal.abdulla617931.chatgpt.site`.
- Trigger production version `20260720.7` deployed successfully with both background tasks registered.
- Fresh public report: `e708dc4399854a6b87faace9b913e0e0` for `al-hamdanisweets.com`.
- The report requested and fetched all six bounded primary price-enrichment pages (`6/6`), with no primary-enrichment coverage gaps.
- The persisted compact catalog contains five products with attributable structured USD prices and secure images. Multi-variant products retain every observed amount; for example, the Ballourie pistachio baklava variants remain `USD 3.99`, `USD 10.99`, and `USD 23.99` instead of being collapsed into a direct competitor delta.
- The overview exposes positive public pricing signals and no longer displays the unattributed `$0` page pattern.
- The run completed as `LIMITED` because competitor discovery returned no verified competitors. That is a separate discovery-lane issue and remains explicitly outside this task's scope; this validation proves primary price and image recovery even when no competitor pair exists.
