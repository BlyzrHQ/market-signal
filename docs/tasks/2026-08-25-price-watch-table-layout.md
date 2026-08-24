# Price-watch table layout

## Problem

On an owned report with price watching enabled, the desktop product table renders seven columns while the fixed-width CSS allocates the full table width across only six. The watch control therefore collapses into the next-move column and covers recommendation text. Responsive grid templates also omit the optional watch cell.

## Scope

- Give the optional watch column an explicit share of the fixed desktop table width.
- Keep the watch switch and cadence selector inside their cell.
- Add an explicit watch area to tablet and phone table-card layouts.
- Preserve the existing six-column layout for reports where price watching is unavailable.

## Acceptance

- The watch controls and next-move recommendation never overlap at desktop, tablet, or phone breakpoints.
- The desktop table remains within its report workspace without horizontal overflow.
- Reports without price watching retain their current column proportions.
- Relevant tests, lint, typechecks, production build, and a real owned report visual check pass.

## Data boundaries

This is presentation-only. It does not change report facts, prices, matches, watcher state, credits, authentication, or billing.
