# Task 095: Recover matched-product enrichment after transient robots failures

## Problem

The Babanuj report `3b06c330ed3748f2a2362ab9e98a7131` discovered product URLs, but the final matched-product enrichment skipped 24 Babanuj pages because a later `robots.txt` request was temporarily unreachable. The same pages expose attributable JSON-LD prices and Shopify CDN images publicly. The initial crawl had already completed a successful robots-aware product enrichment pass, but that successful policy decision was not reused.

## Scope

- Reuse a recent successful robots policy within the server process across crawl and final-enrichment requests.
- Retry bounded transient robots failures and try the canonical `www` host for the same registrable storefront domain.
- Keep authentication, throttling, explicit denial, and unresolved network failures fail-closed.
- Add regression tests for cache reuse, host fallback, and explicit robots denial.
- Validate against the real public Babanuj product page without presenting fixture data as live evidence.

## Acceptance criteria

- A successful robots policy can service a later selected-product enrichment request for the same canonical domain.
- A temporary apex robots failure can recover through a bounded direct `www` request.
- A disallowed product path remains blocked.
- Babanuj enrichment returns its public product image and structured price in a real-data check.
- Focused tests, full tests, lint, VPS build, strict Fable 5 review, PR, merge, and both required deployments complete successfully.

## Data boundaries

- Only first-party public product pages and public robots directives are used.
- Missing or unresolved robots policy remains a visible coverage gap.
- No credentials, cookies, or private storefront APIs are used.

## Architecture review

Verified Fable 5 reviewed the failure trace and recommended one shared resolver with a short bounded cache, same-canonical-domain host fallback, and retries limited to transport failures and 5xx responses. It rejected client-supplied robots policies, database persistence, fail-open handling, and routing around explicit 401/403/429 responses. The implementation follows that boundary and keeps per-path `Disallow` evaluation active on cache hits.
