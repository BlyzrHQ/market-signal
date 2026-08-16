# Show valid SAR price differences

## Problem

The live Asalbarri acceptance report recovered valid Saudi-market prices for both products, but the product table still rendered the difference as unavailable. The presentation parser only recognized GBP, USD, and EUR, so it rejected the same SAR values that the evidence and publication layers already validate.

## Change

- Recognize validated ISO 4217 currency tokens in report price presentation.
- Keep the existing symbol fallbacks for pound, dollar, and euro values.
- Add regression coverage for the exact live SAR pair and for another supported regional currency.
- Continue rejecting arbitrary three-letter tokens.

## Validation

- Focused price-claim tests.
- Full test, VPS build, and lint suites.
- Live Asalbarri table verification after deployment.

## Data boundaries

This changes presentation calculation only. It does not infer a currency, convert currencies, or bypass the report's market, price, identity, or publication gates.
