# Task 117 — Landing proof redesign

## Goal

Replace the text-heavy landing page with a concise product-led experience that proves what Market Signal produces before asking visitors to buy.

## Scope

- Add motion to the hero without hiding or delaying the domain form.
- Add an animated, user-controlled proof showcase for the dashboard, competitors, and product catalog.
- Ground the showcase in the verified MyJam report rather than fixture claims.
- Move pricing and methodology to dedicated routes so the landing page is not every page at once.
- Add a useful multi-column footer and a cleaner sans-serif typography system.
- Respect reduced-motion preferences and keep the layout responsive.

## Product truth

- The proof module is a dated, limited-coverage snapshot with durable links to both primary and rival public product pages; it does not depend on the retained report URL.
- The workflow animation is explicitly described as a recorded MyJam example, not a live customer run.
- Counts and product comparisons come from report `7fb305987e9a439abcbb352ee7302b26` observed on 2026-08-08.

## Acceptance

- Landing page contains only the hero, proof showcase, final CTA, and footer.
- Dashboard, competitor, and catalog proof are manually selectable with keyboard-complete tabs; no content changes automatically.
- The MyJam snapshot states its observation date, limited coverage, observed-price boundary, and AI-assessed product-identity boundary.
- Pricing and how-it-works pages are independently addressable.
- Build, typecheck, lint, focused tests, visual review, and strict reviewer gate pass before merge.
