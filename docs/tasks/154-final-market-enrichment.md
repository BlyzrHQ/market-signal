# Final market-aware match enrichment

## Problem

The production `asalbarri.sa` acceptance run proved that initial rival crawling
could recover a Saudi storefront price, but the post-AI selected-product
enrichment endpoint still followed Hanaa Honey into a redirect-selected German
market. The accepted same-product pages therefore remained unpriced and no
comparison was publishable.

## Change

- Carry the primary report's two-letter country code into final enrichment
  targets.
- Validate that field at the public enrichment boundary.
- Apply one robots-allowed, same-domain locale retry when the storefront itself
  inserted a conflicting locale prefix.
- Preserve the existing identity, currency-conflict, SSRF, and explicit-market
  fail-closed gates.

## Acceptance

- Focused and full automated validation pass.
- Fable 5 returns strict PASS on the exact PR head.
- Trigger is deployed before the exact approved merge reaches the VPS.
- A fresh live `asalbarri.sa` report publishes a comparison only when both sides
  expose finite positive SAR prices; otherwise the remaining gap is reported
  explicitly.
