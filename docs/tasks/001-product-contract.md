# Task 001 — Product contract and trust boundary

## Goal

Create a shared product contract for the first Market Signal release before implementing competitive data collection.

## Scope

- Define the domain-only onboarding promise for startups, agencies, and ecommerce brands.
- Define the first report sections: competitor discovery, market positioning, product/pricing comparison, public ads/social monitoring, recommendations, alerts, and exports.
- Define the evidence model: source URL, observed date, claim type, confidence, and whether a statement is observed, inferred, estimated, or recommended.
- Keep the first release low-friction; defer accounts, teams, and billing until after the initial report proves value.

## Acceptance criteria

- Product scope is documented in `docs/product-contract.md`.
- The MVP implementation sequence is explicit.
- Public-data limitations are visible, including the distinction between observed ads and unverified spend estimates.
- Remaining decisions are recorded as explicit gates before source adapters are built.
- The project builds successfully with the Sites/Vinext toolchain.

## Dependencies and next decision gates

- Select initial ad/social channels.
- Confirm whether estimated spend belongs in the first report.
- Confirm the no-account lead-capture rule.
- Confirm launch language and regional fallback.
- Confirm any budget for paid data providers.
