# Task 003 — Domain intake and first report

## Goal

Give a new user a useful competitive-market read after entering only a domain.

## Scope

- Domain-only intake with no account requirement.
- Automatic competitor set with rationale and confidence.
- Market-positioning snapshot and recommended moves.
- Product/pricing comparison.
- Public ad-signal cards for Meta, Google, and TikTok.
- Estimated spend ranges with confidence and methodology note.
- Evidence ledger distinguishing observed, inferred, estimated, and recommended content.
- Responsive report surface and low-friction export/cadence affordances.

## Acceptance criteria

- A visitor can submit a domain and reach a report without signing in.
- The report exposes all four required output types: dashboard, recommendations, alerts/cadence affordance, and export affordance.
- Competitors are selected automatically in the first experience.
- Estimated spend is never presented as exact spend.
- The page is English-first and presents regional inference as an overridable future capability.
- The current implementation uses clearly labeled fixture evidence until live public adapters are connected.
- `npx vinext build` and `npm run lint` pass.
