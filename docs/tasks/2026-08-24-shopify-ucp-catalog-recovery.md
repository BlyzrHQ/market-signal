# Shopify UCP catalog recovery

## Problem

Some public Shopify storefronts return HTTP 403 to the crawler on both their apex and `www` homepages even though Shopify's official, unauthenticated Storefront Catalog MCP remains available. Babanuj currently fails this way. The existing Salla recovery cannot recover Shopify catalogs, so the report stops before product comparison.

## Product boundary

- Run only after the normal robots-aware crawl has verified HTTP 403 on both submitted homepage hosts.
- Use Shopify's official Storefront Catalog MCP at `https://checkout.<registrable-domain>/api/ucp/mcp`.
- Do not use Sites, a residential proxy, guessed `myshopify.com` hostnames, private APIs, or authentication bypasses.
- Treat recovered catalog fields as observed public storefront facts and preserve their source URLs and observation time.
- Publish only finite, positive prices in a supported currency. Missing, zero, malformed, or unsupported prices remain absent.
- Fail closed when host binding, DNS safety, protocol identity, response shape, pagination, or price conversion is invalid.

## Implementation

1. Derive the submitted registrable domain with a public-suffix-aware library and bind recovery to the exact `checkout.<registrable-domain>` host.
2. Use the shared public-address-pinned fetcher with redirects disallowed by exact-host validation, bounded request/response sizes, and short deadlines.
3. Verify the endpoint exposes Shopify UCP catalog search before calling it.
4. Page `search_catalog` with an opaque bounded cursor until the requested catalog limit is reached or the server declares exhaustion.
5. Convert ISO 4217 minor-unit amounts with an explicit exponent table, preferring positive available variant prices and falling back to a positive price-range minimum.
6. Adapt the recovered products into the existing `DomainCrawl` publication path with `storefront-api` extraction and high-confidence observed claims.

## Validation

- Unit tests cover eligibility, host binding, DNS-safe fetch options, protocol/tool verification, pagination, malformed responses, cross-host URLs, cursor bounds, ISO currency exponents, missing prices, and product caps.
- Crawl-route tests prove a dual-host 403 can recover through Shopify UCP while robots denials and throttling remain ineligible.
- A read-only public probe against `babanuj.com` must return at least one product with a finite positive USD price and an official public product URL.
- Run focused tests, full tests/build/typecheck, lint, and `git diff --check` before review.
- Do not launch a paid report or evaluation as part of validation.

## Validation result

- The focused Shopify/UCP suite passed 16/16 tests, including the crawl-route adapter that replaces a verified dual-host HTTP 403 with a live positively priced catalog.
- The full suite passed 1,191/1,191 tests; both typechecks and the production build passed.
- Lint completed with zero errors and one pre-existing `no-img-element` warning in `product-design-lab.tsx`.
- A bounded read-only probe of `babanuj.com` recovered five official storefront products, each with a finite positive USD price and an exact `checkout.babanuj.com/products/...` source URL.
- No report, AI comparison, paid search, or evaluation was launched.

## Review

The preceding architecture review required exact-host binding, public-IP pinning, public-suffix-aware derivation, bounded schemas and cursors, an ISO 4217 exponent table, and a separate stacked PR from durable comparison progress. A strict exact-head Fable 5 review is required before merge.
