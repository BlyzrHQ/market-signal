# Crawler identity recovery

## Production evidence

The live MyJam report `9ead3efaf49b41b895ca7a6673936d5b` resolved the expected Solo entitlement of 20 products, but failed before collecting any products. The production container received HTTP 429 for `https://myjam.co.uk/robots.txt` when using `MarketSignalPublicScanner/0.1`. From the same container, the shorter honest identity `MarketSignal/1.0 (+https://signal.blyzr.com/how-it-works)` received HTTP 200. A browser identity also received HTTP 200, but browser impersonation is explicitly rejected.

## Change

- Centralize the public crawler identity and robots tokens.
- Use the honest `MarketSignal/1.0` identity consistently for robots, crawl, enrichment, Salla recovery, analysis, and public attribution requests.
- Continue honoring the legacy `MarketSignalPublicScanner` robots token so an existing site opt-out is never loosened by the rename.
- Document the crawler identity and robots opt-out on the linked public page.
- Keep the existing fail-closed robots behavior and request bounds.
- Preserve the current product contract: every plan targets 20 priced comparisons per report; plans differ by monthly report allowance.

## Validation

- Unit coverage proves the identity is centralized, attributable, and not browser-shaped.
- Robots parsing selects the new `MarketSignal` token.
- Run focused and full tests, both typechecks, and the production build.
- Obtain strict verified Fable 5 review before merge.
- Deploy Trigger before the exact approved VPS revision.
- Verify the exact production revision and a no-cost production-container robots probe. Do not launch a paid report without the user's approval.
