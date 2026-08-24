# Kuwait market inference and direct-search identity handoff

## Objective

Restore direct product comparison searches for Kuwait storefronts and prevent valid rival product pages from being rejected when a search provider labels a result with only the seller domain.

## Production evidence

- `noororganicfood.com` report `ab31d6f478134208aab3b64e3e669afa` crawled 250 products, but every matcher request was rejected before search because the inferred market code was an empty string and the match API requires a two-letter code when the field is present.
- Public Noor evidence includes `KWD`, `+965`, and `الكويت`; the current region table did not support Kuwait.
- `wearform.com` report `0b95d620634945a9b52e89b4ac119fb8` completed with zero comparisons even though its paid search checkpoint contained five concrete rival product URLs.
- Wearform search candidates were handed to enrichment with seller-domain labels such as `dicksworkclothing.com` as the expected product name. The fetched page exposed the real NOMEX coverall title, so identity validation correctly rejected the mismatched input.
- The one currently priced Wearform lead uses an exact root-level X-Cart `.html` product page. Its first-party markup contains exactly one product-bound `addProduct` record (`CNB2 -CAT 1`, USD 232.99), but enrichment neither recognized that route as a detail page nor removed `.html` before slug identity matching. Pages exposing only shipping or customization amounts had no equivalent product-bound base price and must remain excluded.
- A read-only crawl against the current production worker recovered 755 Wearform products, including 19 products with finite observed prices. The failure is therefore downstream of crawl coverage.

These are observed production diagnostics. No fixture value is represented as a customer result.

## Product contract

- Infer Kuwait only from attributable Kuwait signals such as `.kw`, a Kuwait locale/address, KWD, `+965`, or explicit Kuwait text.
- Omit an unresolved optional market code from matcher requests instead of serializing an invalid empty value and entering a retry loop.
- Direct product search must investigate the exact non-root seller product URL returned by search, including private structured leads.
- Product enrichment must receive a product-shaped expected name derived from the exact result page, never a bare seller domain when a useful product URL is available.
- A root `.html` page may contribute a price only when it contains exactly one product-bound analytics action, one finite positive amount, and one unambiguous supported ISO currency from the same first-party document.
- Recognized page extensions are transport syntax, not product identity tokens.
- Root pages, listing pages, unsafe URLs, and candidates without a usable exact product page remain excluded.
- Customer-visible comparison rows still require a fetched first-party page and a finite, positive, supported-currency price.

## Scope

- Extend region inference and strict region parsing for Kuwait.
- Harden matcher payload serialization for unresolved markets.
- Repair the direct-search candidate URL/title handoff.
- Recover identity-gated X-Cart product-price evidence from exact root `.html` product pages while rejecting missing, contradictory, or ambiguous price evidence.
- Add regressions using the observed Noor and Wearform failure shapes.

## Validation

- Focused region, discovery, direct-search, route, and orchestration tests.
- Full test, lint, and build validation.
- A no-AI live enrichment check against `https://www.workingclassclothes.com/nomexA-iiia-4.5-oz-flame-resistant-deluxe-coverall.html` returned the exact Bulwark product at USD 232.99 with no gap. The Dicks Work Clothing and Occupational Apparel pages remained excluded because no finite product-bound base price was observed.
- Strict exact-head Fable 5 review before merge.
- Deploy Trigger before the exact merged VPS application revision, then verify production health and no-cost diagnostic behavior.

## Cost boundary

Do not launch a paid production report as part of this task without a separate explicit decision. Reuse existing production evidence and no-cost crawl/enrichment checks for rollout verification.
