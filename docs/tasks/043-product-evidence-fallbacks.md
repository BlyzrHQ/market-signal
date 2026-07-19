# Task 043 — Product image and price evidence fallbacks

## Outcome

Increase the number of accepted product matches that show attributable public images and comparable public prices without weakening exact-product identity checks.

## User problem

A product battle is much less useful when either side says “Price not observed” or omits the product image even though the linked public product page visibly contains both. Babanuj is the first real-domain investigation target.

## Acceptance criteria

- Diagnose missing image and price evidence from the exact public product page before adding a fallback.
- Preserve the evidence hierarchy: structured product JSON-LD first, exact-page product/Open Graph/Twitter metadata second. Do not parse generic hydration or flight blobs unless a later task proves a safely identity-bound format is necessary.
- Accept a fallback only when it belongs to the exact product page and matches the expected product identity; never borrow a related-product image or price.
- Require explicit currency evidence before producing a comparable numeric price.
- Resolve relative and HTML-encoded public image URLs against the fetched product page, then retain only HTTP(S) media URLs.
- Keep robots checks, same-domain page fetching, redirect limits, request timeouts, and document-size bounds unchanged.
- Record the extraction method and expose a visible coverage gap when the page remains inaccessible or ambiguous.
- Add adversarial tests for related products, shipping thresholds, ambiguous prices, mismatched handles, redirect path changes, malformed structured data, and public off-domain CDN media.
- Validate the implemented method against at least Babanuj and one additional real public storefront before completion.

## Boundaries

- No browser automation against merchant storefronts in the production crawler.
- No private APIs, checkout sessions, cookies, or authenticated data.
- No price inference from search snippets or unrelated marketplace listings.
- No placeholder images in live customer reports.

## Diagnosis

- The raw Babanuj product response contains an exact same-page Product JSON-LD record with explicit USD price evidence and a public Shopify CDN image. A production-UA route reproduction accepted the identity and returned both fields, so a headless browser or generic Next flight parser is not required for this storefront.
- The AI-match request sanitizer discarded every image hosted away from the merchant domain. This removed legitimate Shopify CDN images before comparison.
- Final enrichment joined the accepted fresh record back to a comparison only by canonical URL. Identity validation intentionally allows a safe redirect when the structured identity is exact, so a path-changing redirect could count as fetched and then silently lose its evidence during the join.
- Incomplete JSON-LD records were not supplemented from title-matched same-page product metadata, and relative/protocol-relative images were not resolved.
- Visible page price strings can include shipping thresholds and related-product prices. They are no longer promoted to an ecommerce product price without explicit product metadata and currency.

## Implemented method

1. Keep complete JSON-LD product evidence.
2. For the one JSON-LD Product whose identity is supported by the page title, fill only missing price/image fields from explicit same-page product, Open Graph, Twitter, or itemprop metadata.
3. Resolve relative and protocol-relative images against the fetched page; retain public HTTP(S) extraction values and only pass public HTTPS media through the AI route.
4. Carry the selected product ID through validated enrichment and join by that stable ID before falling back to canonical URL matching.
5. Persist role, product ID, source URL, and reason for every enrichment gap and show the gap in the saved Products view.

Generic embedded storefront-state parsing is intentionally deferred: Babanuj does not require it, and its related-products arrays make a broad parser more likely to borrow the wrong price or image than to add trustworthy evidence.

## Review record

- Fable 5 research identified the CDN sanitizer, redirect-sensitive final join, missing same-page metadata supplement, and invisible gap reasons as blockers.
- The first strict implementation review blocked on a mojibake dash regex and missing related-product/ambiguous-identity supplement tests.
- Both blockers were fixed: the regex now uses real em/en dashes, the supplement requires exact normalized page-title identity, a related walnut product cannot borrow pistachio metadata, and two exact claimants reject supplementation.
- Fable 5 re-reviewed the complete changed set and returned `APPROVE — both blockers are resolved`, confirming the redirect join, CDN media handling, conservative metadata fallback, gap visibility, and unchanged crawl guardrails.
- Final GitHub-attached strict `PASS` and Fable merge execution remain pending after the draft pull request and checks exist.

## Validation record

- Babanuj: the production enrichment route accepted `Zaitoune Mamoul With Pistachio 500g` from its exact public product page and returned `USD 43.2` plus the attributable Shopify CDN image.
- MyJam: the production enrichment route accepted `Lamb Leg Halal apx 2500g` from its exact public product page and returned `GBP 39.05` plus the attributable product image. The real check also found and fixed an identity false rejection caused by a marketing-prefixed title overriding the exact product H1.
- Both checks used the production scanner user agent, robots policy, redirect controls, timeout, and document-size limit. Result: 2 requested, 2 fetched, 0 gaps.
- Automated validation: typecheck and vinext build pass; 210/210 Node tests pass; lint has zero errors and two existing remote-image optimization warnings; `go test ./cli/... ./contracts/...` passes.
