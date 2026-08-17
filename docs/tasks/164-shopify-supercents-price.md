# Shopify superscript-cents and Starter matching recovery

## Problem

The first post-deploy MyJam Starter report persisted the correct 20-product
entitlement but still suppressed selected prices. MyJam's current theme renders
decimal cents as malformed superscript markup such as
`£20<sup>25 </span>`. The visible-price parser reduced that to GBP 20 while
the product metadata and identity-gated Shopify JSON both exposed GBP 20.25,
so the existing integrity gate correctly rejected the disagreement.

The same report selected viable rival candidates but published zero matches.
A production-data diagnostic scored 1,004,003 retrieval pairs and completed 20
primary-product assessments in 30.5 seconds, producing 15 verified assignments.
That leaves too little variance headroom under the existing 45-second small-report
budget and explains why a slower live attempt could exhaust the deadline before
the judge returned any usable assessment.

## Change

- Preserve two superscript cents inside a currency-qualified current-price
  element before HTML tags are stripped.
- Continue requiring agreement with direct product metadata and the
  identity-gated Shopify payload before publication.
- Do not relax currency, country, robots, product identity, quantity, or
  positive-price gates.
- Preserve the Starter entitlement at 20 products per report.
- Raise only the matching budget for reports assessing at most 60 products from
  45 to 90 seconds. Larger plan budgets and all matching acceptance rules remain
  unchanged.

## Validation

- Add a regression fixture using the exact public MyJam markup shape.
- Assert the 20-product route receives the bounded 90-second budget.
- Run focused enrichment tests, the full suite, lint, and VPS build.
- Re-run the real MyJam product adapter and require GBP 20.25 with no gap.
- Re-run a fresh Starter report and require 20 assessed products plus at least
  one verified, publishable comparison.
- Obtain strict exact-head review before merge and deploy Trigger before the
  exact approved VPS revision.

## Data boundaries

Superscript cents are accepted only within an already selected product price
element and remain subject to the existing independent amount and currency
agreement checks. No amount is inferred from locale or domain.
