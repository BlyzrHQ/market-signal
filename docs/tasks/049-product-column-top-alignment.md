# Task 049: product-column top alignment

## Problem

In the saved-report product comparison table, the Price signal card starts 17px below the row edge while the Next move content starts 21px below it. The four-pixel difference makes the two decision columns look vertically disconnected.

## Decision

Use the existing 17px row-content anchor for both decision columns. Keep the action cell's 19px inline padding and 21px bottom padding so wrapped recommendations retain breathing room. Do not vertically center either column because variable row heights would make their starting positions inconsistent between comparisons.

## Acceptance criteria

1. The Price signal panel and the Next move line box begin on the same 17px top anchor on desktop.
2. At the two-column responsive layout, the Price signal and Next move labels share the same top baseline.
3. The stacked mobile layout keeps the action cell's separation and bottom breathing room.
4. English and Arabic/RTL layouts remain direction-safe and do not overflow.
5. A regression test locks both top-padding values to 17px.
6. A saved real-data report is visually checked after deployment.

## Fable 5 decision review

Model: `claude-fable-5`

Outcome: **PASS**. Fable confirmed the four-pixel padding mismatch is the defect and recommended `padding: 17px 19px 21px` for the action cell. Vertical centering was rejected because variable product-row heights would create inconsistent scan lines across rows and break the existing top-anchored layout system.
