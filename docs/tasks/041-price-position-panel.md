# Task 041 — Price position panel

## Outcome

Replace the arbitrary price axis with a decision-first price position panel in both live and saved product-comparison reports.

## User problem

The existing line and dots imply precision without explaining the commercial result. Saved report cards reduce price to a small product attribute, so the user must interpret the gap manually.

## Acceptance criteria

- Use one shared Price Position component in the live renderer and saved report route.
- Show both observed public prices as distinct `YOU` and `RIVAL` values.
- For a server-approved comparable pair, show exactly one plain-language result: you are cheaper, the rival is cheaper, equal price, or an under-1% gap.
- Show the absolute difference in the shared currency when unequal.
- State visibly that the percentage is relative to the higher observed price.
- Never show a percentage or absolute gap unless `resolvedPriceDelta(decision.priceComparison)` succeeds.
- For missing, ambiguous, cross-currency, or close-substitute pricing, show `No direct price comparison`, both raw prices when available, and the server price verdict.
- Remove all price-axis, line, dot, collision, and RTL-positioning code.
- Preserve RTL behavior and stack cleanly without horizontal overflow at 320px.

## Truth boundary

The server's `productDecision` remains the authority on whether a pair is comparable. The shared presentation component can narrow that decision when parsing fails, but it cannot widen it.

## Review

Fable 5 approved the decision-first panel and rejected repairing the old axis, publishing percentages for close substitutes, or normalizing currencies. Its hierarchy and truth-boundary criteria are incorporated above.
