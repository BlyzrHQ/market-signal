# Task 107 — Expand the product comparison workspace

## Customer problem

On a wide desktop, the product comparison panel stops at 1,140px and leaves a large unused area on the right. The six-column comparison table becomes unnecessarily compressed even though the dashboard has available space.

## Scope

- Let the Products panel use the full available dashboard-main width.
- Keep the existing readable 1,140px limit for Competitors and Benchmark.
- Preserve the existing tablet/mobile card transformation and horizontal-overflow protections.

## Acceptance

- The Products panel fills the report canvas on wide desktop viewports.
- Product names, prices, differences, and next moves receive the extra space.
- Other report tabs retain their current reading width.
- Tablet and mobile report layouts continue to use `width: 100%` without horizontal page scrolling.

## Data boundary

Presentation only. No saved reports, product matches, prices, images, evidence, or recommendations change.
