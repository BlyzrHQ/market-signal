# Task 053 — Storefront product adapters

## Outcome

Recover exact public product prices and images from storefront-native product endpoints when a product page omits usable JSON-LD or Open Graph fields. Keep the existing product-identity gate as the final authority so richer data never overrides a contradictory product, variant, quantity, SKU, or GTIN.

## Scope

- Detect Shopify `/products/<handle>` and WooCommerce `/product/<slug>` pages selected for final enrichment.
- Make at most one additional robots-allowed, same-domain request when the HTML result lacks a confirmed-currency price or secure image.
- Parse Shopify's public product `.js` payload and WooCommerce's public Store API response.
- Confirm Shopify currency from the same public HTML document; never infer currency from the domain, region, or top-level domain.
- Preserve the human product page as the evidence URL while recording adapter failures as visible coverage gaps.
- Represent structured storefront evidence explicitly as `storefront-api` extraction rather than fixture data or generic page prose.

## Safety boundaries

- The requested Shopify handle or WooCommerce slug must exactly match the adapter payload.
- Adapter records pass through `validateProductPageIdentity` without bypasses.
- Existing hard conflicts for quantity, SKU, MPN, and GTIN remain authoritative.
- Multi-variant prices remain a range unless one expected quantity selects exactly one variant; unresolved ranges do not produce a direct price delta.
- Shopify prices without a same-page ISO currency remain non-comparable and produce a coverage gap.
- Shipping thresholds, cart totals, related-product cards, and arbitrary visible numbers are not parsed by these adapters.

## Acceptance criteria

- A matching Shopify payload enriches a selected product with the exact observed price and secure image.
- A Shopify payload without confirmed currency can enrich an image but cannot create a comparable price.
- A repurposed handle, wrong quantity, conflicting SKU/GTIN, or conflicting variant remains rejected.
- A matching Woo Store API product enriches price and image; a mismatched slug is rejected.
- Robots denial and blocked/invalid adapter responses remain explicit gaps while valid HTML evidence can still be returned.
- Existing product-intelligence and route tests remain green.
- Real public checks cover MyJam Shopify data and at least one WooCommerce storefront outcome.

## Fable 5 architecture review

Fable 5 reviewed the existing route, extractor, identity validator, and tests in read-only mode. It recommended the smallest safe design: add storefront-native structured endpoints only when price or image is missing, convert their payloads into normal `ProductRecord` candidates, and append them before the unchanged identity validator. It required same-domain redirects, robots checks, exact handle/slug checks, confirmed Shopify currency, one extra request per target, variant-safe price handling, explicit endpoint gaps, and real-domain validation. Those constraints are adopted here.

## Validation

- Typecheck and production build passed.
- All 230 automated tests passed; lint completed with zero errors and the one pre-existing external product-image warning.
- Focused adapter, enrichment-route, and product-intelligence tests passed, including Shopify JPY/KWD hundredths, Woo variable-price ranges, HTML sanitization, robots query rules, identity drift, SKU/GTIN conflicts, endpoint failure fallback, and shipping-threshold safety.
- Real public validation recovered MyJam's sirloin product as GBP 12.57 with a secure image through the Shopify endpoint, retained Halal Fine Foods parsley at GBP 1.20 from JSON-LD, and returned My Meat Shop's blocked Woo Store API as an explicit coverage gap while preserving its page/image evidence.
- The first strict Fable 5 code review returned `REVIEW: BLOCK` on Shopify non-two-decimal conversion, Woo variable ranges, HTML descriptions, and robots query matching. All four were fixed with regression tests. Fable re-read the changes, independently ran the full suite, and returned `REVIEW: PASS` with no remaining blockers.
- PR, merge, and deployment verification remain pending.
