# Task 039 — Full-width image-less product content

## Problem

Stored product-comparison cards keep a 62px image column even when the primary product has no public image. The name and price are explicitly placed in that reserved column, so ordinary multi-word product names wrap almost one word per line while most of the product panel remains empty.

## Outcome

- Collapse an image-less product panel to one flexible content column.
- Let the label, product name, and price use the full available half-card width.
- Preserve the existing two-column image-and-content layout when an image is available.
- Preserve the stacked mobile comparison layout and Arabic direction.

## Acceptance criteria

1. An image-less product name uses the full product panel width instead of the 62px image slot.
2. Products with images keep their image and content columns.
3. Long English and Arabic product names wrap naturally without horizontal page overflow.
4. The comparison pair remains side by side above 700px and stacked at 700px and below.
5. Build, tests, lint, Go tests, strict Fable 5 review, exact Sites deployment, production browser QA, and Fable merge pass.

## Data boundaries

This is a presentation-only fix. It does not invent product images or change crawled names, prices, product matching, confidence, persistence, or evidence.
