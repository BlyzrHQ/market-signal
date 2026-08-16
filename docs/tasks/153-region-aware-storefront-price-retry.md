# Region-aware storefront price retry

## Problem

A fresh `asalbarri.sa` production report recovered 20 first-party Salla products
with valid SAR prices and images, but its verified Saudi rival exposed no usable
prices. The VPS requested a market-neutral Zid product URL and was redirected to
an `ar-de` storefront whose structured offer used EUR. The same public product
at the explicit `ar-sa` URL exposed its Saudi SAR offer.

## Change

- Detect only same-origin redirects that insert a conflicting `language-country`
  prefix in front of the exact requested product path.
- Retry that product once with the primary report's observed country code.
- Never override an explicit locale or market query from the evidence URL.
- Reapply robots policy to the retry path and retain the existing identity,
  currency, source-domain, and publication gates.
- Prefer an explicit `product:sale_price` metadata pair over list-price metadata
  when it corroborates the structured current offer; malformed or contradictory
  sale metadata still fails closed.

## Validation

- Unit coverage for the accepted Saudi retry and fail-closed URL cases.
- Full test, build, lint, Go, and real public `hana.com.sa` checks.
- Strict Fable 5 review before merge.
- Trigger-first and exact-commit VPS deployment, followed by a fresh
  `asalbarri.sa` report with persisted price evidence verification.
