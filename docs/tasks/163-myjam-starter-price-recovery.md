# MyJam Starter price recovery

## Problem

The latest live `myjam.co.uk` Starter report correctly limited matching to 20
primary products, but only three comparisons were publishable. Seventeen
otherwise accepted pairs were suppressed because MyJam's Shopify product pages
exposed the active GBP market in Shopify's first-party runtime bootstrap while
the legacy product JSON endpoint exposed only minor-unit amounts. The existing
adapter ignored all script state, leaving only six of 1,001 primary products
with comparable prices.

## Change

- Recognize a Shopify runtime market only when one active top-level script
  uniquely binds a valid `*.myshopify.com` shop, ISO currency, and ISO-2 country.
- Ignore comments and inert containers, and fail closed on duplicate or
  conflicting runtime assignments.
- Apply the runtime currency only to the same-origin Shopify product adapter
  when the URL has no explicit market selector and the runtime country agrees
  with the report market when known.
- Preserve the 20-products-per-report Starter entitlement and all existing
  robots, identity, quantity, amount-conflict, supported-currency, and
  publication gates.
- Do not request Shopify's `/cart.js`; MyJam's robots policy disallows it.

## Validation

- Focused adversarial adapter and enrichment tests.
- Full test, lint, and VPS build validation.
- Strict verified Fable 5 review on the exact PR head.
- Trigger-first and exact-commit VPS deployment.
- Fresh live Starter report for `myjam.co.uk` proving a 20-product entitlement
  and materially recovering finite positive GBP comparisons without publishing
  unsupported currencies.

## Data boundaries

The recovered currency is public first-party page state for the active Shopify
market. It is not inferred from the domain, country, prior reports, or a blocked
endpoint. Any contradictory or ambiguous market evidence remains non-comparable.
