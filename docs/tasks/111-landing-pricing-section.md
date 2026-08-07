# Task 111 — Landing-page pricing section

## Goal

Add a clear pricing section to the main landing page using the measured-cost hypotheses from Task 108 without claiming that unsupported capacity or active billing already exists.

## Product decisions

- Show hosted Starter, Solo, Growth, and Agency plans alongside the planned self-hosted source release.
- Use “products analyzed,” never “product matches,” because a run does not guarantee one accepted rival for every product.
- Starter is USD 8 for five completed reports and up to 20 selected products per report.
- Solo, Growth, and Agency use the approved 50, 500, and 1,000 per-report product targets.
- Mark Growth and Agency as coming soon until deep-catalog support exceeds the current bounded 60-product capability and passes cost/quality gates.
- Describe all prices as launch targets while billing and quota enforcement remain unimplemented.
- Replace the “one free report” statement with an honest metered-beta access state.

## Acceptance criteria

1. Pricing is reachable from the main navigation and works in English and Arabic.
2. Each plan presents price, completed runs, products analyzed, monitored domains, seats, and the most important workflow feature.
3. The private, unlicensed repository is presented as a preview of a planned source release—not as publicly available open source.
4. No card claims active checkout, unlimited hosted usage, or currently unsupported 500/1,000-product processing.
5. Desktop, tablet, and mobile layouts have no horizontal overflow.
6. Source tests, rendered HTML, build, lint, and responsive browser checks pass before review.
7. Pricing is visible from the first viewport through a dedicated hero action, including on mobile.
8. The landing page includes a clear GitHub preview action and states that public release follows licensing and security review.
9. The landing copy describes the product-first discovery flow and the priced-rival publication rule.
