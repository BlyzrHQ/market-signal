# Task 050: remove visible match metadata

## Problem

Every accepted product comparison repeats the same low-value metadata above the product cards: an Inferred badge, Medium confidence, and a match verdict such as Same product. The strip delays the useful product information and makes the Product pair column start lower than Price signal and Next move.

## Decision

Remove the match-metadata strip from the primary comparison row. Start the two product cards directly on the shared 17px top anchor used by the other columns. Preserve claim type, confidence, verdict, and match reasons inside the expandable Why this match? detail so the report remains transparent without repeating process metadata in the scan path.

Update the product-view introduction so it accurately describes the simplified hierarchy. Do not change matching, prices, evidence, or persisted report data.

## Acceptance criteria

1. Inferred, confidence, and match-verdict labels do not appear above the product cards.
2. Product pair, Price signal, and Next move begin at the same top anchor on desktop.
3. Claim type, confidence, verdict, and reasons remain available inside Why this match?.
4. The removed heading and tag CSS are not left behind.
5. Tablet, mobile, English, Arabic/RTL, and long product names remain overflow-free.
6. Tests prevent the visible metadata strip from returning without an intentional decision.
7. A saved real-data report is checked after deployment.

## Fable 5 decision review

Model: `claude-fable-5`

Outcome: **recommended**. Fable found that claim type is constant for product matches and confidence is effectively constant for accepted rows, so the visible labels carry almost no comparative information. It recommended removing the strip while retaining those fields in the match-detail disclosure and correcting the introductory copy.
