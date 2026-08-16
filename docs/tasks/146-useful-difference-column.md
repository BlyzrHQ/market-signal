# Task 146 — Useful product price difference

## Outcome

Make the product table's Difference column answer three questions at a glance:
how large the observed monetary gap is, which side lists lower, and whether the
comparison is direct, unit-normalized, or only a non-like-for-like listed-price
observation.

## Truth boundaries

- Verified direct matches may show a percentage and absolute gap.
- Compatible quantities may show a computed per-unit gap and must label it as
  computed.
- Close substitutes may show the arithmetic gap between two same-currency
  public prices, but must say that pack and variant alignment is unverified.
- Missing, ranged, unsupported, and cross-currency prices must not invent a
  numerical gap.
- Existing direct-price metrics and publication gates remain unchanged.

## Acceptance criteria

- The monetary amount is the strongest visual element in the Difference cell.
- A concise direction label says which side lists lower.
- A compact basis note distinguishes verified, computed, and not-like-for-like
  comparisons.
- English and Arabic preserve the same evidence boundary.
- Price-claim tests cover direct, normalized, listed-gap, and unavailable states.
