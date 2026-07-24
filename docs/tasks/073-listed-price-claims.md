# Task 073 — Useful listed-price claims

## Outcome

Replace the opaque `comparison basis unverified` state with the strongest truthful
price claim supported by the saved public evidence.

## User problem

When two public prices are visible, the report currently refuses to state any
numerical difference unless the products passed the strict direct-comparison
gate. Customers reasonably read this as the system failing to use prices it
already collected.

## Claim hierarchy

1. A server-approved comparable pair retains the existing cheaper/equal
   percentage and absolute gap.
2. Two single same-currency prices with compatible canonical quantities of
   different sizes receive a visibly computed unit-price comparison:
   - mass per 100g;
   - volume per 100ml;
   - count per item or pack only when the canonical unit is identical.
3. Two single same-currency prices without an aligned comparison basis receive
   an absolute listed-price claim such as `Rival listed price is GBP 0.75
   lower`. This is not phrased as the product being cheaper and does not show a
   percentage.
4. Price ranges, unsupported formats, and cross-currency pairs keep both raw
   observations visible and explain why a single numerical gap is unavailable.
5. One-price and no-price states remain explicit.

## Truth boundaries

- `cheaper` and direct percentages remain restricted to the existing
  server-approved `priceComparison`.
- A listed-price gap is arithmetic over two public observations, not a claim
  that the products have equal quantity, variant, quality, or included value.
- Unit prices are computed, not observed, and must say so.
- No currency conversion, inferred quantity, or range midpoint is permitted.
- Arabic and English must present the same evidence boundary.

## Acceptance criteria

- `GBP 1.89` versus `GBP 1.14` without an approved pair says the rival's listed
  price is `GBP 0.75 lower` and withholds a percentage.
- `GBP 4 / 500g` versus `GBP 3 / 250g` without an approved pair compares
  `GBP 0.80/100g` with `GBP 1.20/100g` and labels the result as computed.
- A verified direct pair retains its current percentage and gap.
- A sub-1% direct difference never says `0% cheaper` or assigns the wrong lead.
- Ranges and different currencies do not produce a numerical gap.
- Table, matchup, opportunity, and CSV views use the same claim state.
- Saved public source links and raw price labels remain unchanged.

## Export compatibility

The CSV `price_status` vocabulary now uses the shared claim kinds (`direct`,
`unit-normalized`, `listed-gap`, `listed-equal`, `approved-unparsed`,
`both-observed`, `one-observed`, and `none-observed`). Parsed amount and currency
columns are populated for observed non-direct pairs as well as direct pairs.
Consumers that previously treated empty amount columns as equivalent to an
unverified basis must migrate to `price_status`.

## Product-decision review

Verified Fable 5 recommended preserving the existing direct-comparison gate and
identified three consistency risks: contradictory labels across layouts,
`0% cheaper` rounding, and overstated CSV status. The implementation preserves
that gate. Codex rejected Fable's recommendation to hide all arithmetic for
non-approved pairs because the user explicitly requested a useful claim from
two observed prices. The selected wording distinguishes `listed price is lower`
from `product is cheaper`, withholds a percentage, and labels normalization as
computed.

## Validation

- `npm test`: **350/350 pass**, including typecheck and production build.
- `npm run lint`: **0 errors**; the two pre-existing raw product-image warnings
  remain visible.
- `go test ./cli/... ./contracts/...`: pass.
- Strict Fable 5 round one: blocked wording that asserted size/variant
  misalignment instead of unverified alignment, and a unit-price headline that
  omitted the computed disclosure in the opportunities/CSV surfaces.
- The fixes make alignment epistemic (`not verified as aligned`), put
  `computed` directly in every normalized headline, validate quantity
  kind/unit coherence, and derive CSV match status from confidence rather than
  a truthy fallback verdict.
- Strict Fable 5 round two: **PASS**, no merge blockers. It verified the shared
  state across table, matchup, opportunities, and CSV; direct-vs-listed truth
  boundaries; sub-1% handling; Arabic parity; and the new regression tests.
- Pull request, exact Sites deployment, and a fresh MyJam report remain pending.
