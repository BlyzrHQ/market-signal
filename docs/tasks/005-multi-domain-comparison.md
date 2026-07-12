# Task 005 — Multi-domain public comparison

## Decision

Keep domain-only onboarding, but allow up to three optional comparison domains. Run every submitted public domain through the same bounded analyzer and replace fixture competitor/pricing/evidence panels with observed source records when comparison domains are present.

## Scope

- Preserve the primary domain as the only required input.
- Add up to three optional comparison domains.
- Fetch comparison domains in parallel with the existing public HTML analyzer.
- Show live title, pricing patterns, headings, source URL, language, and social-link evidence side by side.
- Keep ad panels clearly illustrative until platform-specific public adapters exist.
- Return per-domain errors without hiding successful results.

## Acceptance criteria

- A primary domain alone still produces the current live source profile.
- A primary domain plus one to three comparison domains produces a real side-by-side comparison.
- Competitor and product/pricing panels use observed public data when comparison domains are supplied.
- Individual comparison failures are visible and do not erase successful results.
- No exact ad spend or private data is introduced.
- Build, lint, tests, live local verification, PR, and private Sites deployment pass.
