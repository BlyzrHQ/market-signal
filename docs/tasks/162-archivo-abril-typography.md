# Archivo + Abril typography

## Objective

Apply the Archivo + Abril Fatface pairing from the referenced typography carousel to Market Signal without reducing report readability or Arabic support.

## Decision

- Use Archivo for navigation, controls, body copy, metrics, tables, and dense report UI.
- Use Abril Fatface selectively for major English display headings on the landing page, standalone pages, account entry points, and report section introductions.
- Keep the existing Arabic system-font override because Abril Fatface and Archivo do not provide Arabic glyph coverage.
- Bundle both fonts with Fontsource so Vinext emits stable, self-hosted assets rather than depending on a runtime Google Fonts request.

## Why this pairing

Among the six pairings in the supplied post, Archivo + Abril best matches Market Signal's two jobs: a calm, legible data product and a distinctive editorial brand. The other pairings were either too generic, too theatrical, or too display-heavy for tables and evidence-rich reports.

## Validation

- TypeScript checks
- ESLint
- Production build
- Automated typography contract test
- Visual QA on landing, account, and pricing locally; responsive rules checked statically; saved-report QA after deployment
- Strict Fable 5 review before merge

## Data-source boundary

This is a presentation-only change. It does not alter report collection, evidence, matching, pricing, billing, authentication, or stored customer data.
