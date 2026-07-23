# Task 072 — Ads coming soon

## Request

Keep Ads visible in the report navigation as a coming-soon feature, remove the current Ads report surface, and remove the report Methodology section.

## Product interpretation

- Ads remains visible as a disabled roadmap item labelled `Ads — Coming soon` / `الإعلانات — قريباً`.
- Ads is not an active report view and exposes no saved ad result, count, competitor link, or deep-link target.
- Existing backend ad collection and persisted report data remain unchanged so the feature can be restored later.
- “Methodology” means the report Methodology section. The public landing-page explanation of the product’s general method remains.
- The Evidence view remains and is renamed from `Evidence & Method` to `Evidence` / `الأدلة`.
- Removing Methodology must not remove the report’s evidence ledger, source links, confidence labels, coverage gaps, or truth boundary.

## Routing and accessibility

- `?view=ads` is a legacy route and must be replaced with `?view=overview`.
- `?view=methodology` is a legacy route and must be replaced with `?view=evidence`.
- Legacy redirects clear obsolete hashes.
- The coming-soon Ads item uses tab semantics, is visibly disabled, is excluded from roving keyboard navigation, and cannot become selected.
- Desktop, mobile, English, Arabic, LTR, and RTL navigation behavior must remain valid.

## Copy changes

- The landing page must not promise ad analysis as part of the current report.
- The Ads pillar is visibly marked coming soon in both languages.
- Terminal-domain reports must only describe the currently active competitor and product phases.
- The competitive benchmark must direct users to evidence details, not methodology.
- Evidence retains: “Anything not observed here is a coverage limit, never evidence of absence.” and its Arabic equivalent.

## Fable 5 decision

Strict product review with verified `claude-fable-5`: **PASS**.

Key review requirements incorporated here:

- Remove Ads from the active view union and active view list.
- Remove the Ads panel, competitor-to-Ads links, ad-only presentation helpers, and active Ads count.
- Keep the disabled item outside active tab refs and keyboard indices.
- Remove the plain-language Methodology panel and its CSS.
- Preserve the benchmark’s own “How was this comparison calculated?” disclosure.

## Acceptance criteria

- [x] Ads is absent from active report views.
- [x] Ads appears as a disabled, accessible coming-soon item in English and Arabic.
- [x] Ads cannot be activated by click or keyboard.
- [x] Legacy Ads and Methodology URLs safely redirect.
- [x] No Ads report UI or competitor Ads link remains.
- [x] Evidence is renamed and retains all decision-supporting source and coverage-limit content.
- [x] Landing and terminal-state copy reflect the current feature set.
- [x] Focused route tests, full tests, lint, and production build pass.
- [x] Strict Fable 5 implementation review passes before merge.
- [ ] Public deployment is performed only after explicit Sites release approval.

## Validation

- Focused routes: `node --test tests/report-routes.test.mjs` — 11/11 passed.
- Full suite: `npm test` — typecheck passed, production build passed, 342/342 tests passed.
- Lint: `npm run lint` — zero errors; one pre-existing `next/no-img-element` warning in `product-design-lab.tsx`.
- Strict implementation review with verified `claude-fable-5`: **PASS**, no blockers.
- Non-blocking review note: dormant Ads presentation CSS remains available for the future feature; no Ads presentation component or route uses it.
