# Task 101 — Catalog drift reconciliation

## Problem

The Firecrawl benchmark proved that some Babanuj sitemap URLs still resolve but now publish a different live product identity. Market Signal correctly refuses to attach the new image and price to the stale product name, but the stale record then remains in the catalog and produces an avoidable empty comparison.

## Decision boundary

Reconcile drift only during the bounded pre-match catalog-enrichment phase. Final post-match enrichment must continue to reject a changed identity because replacing one side after matching would invalidate the product pair without rerunning the matcher.

A stale record may be replaced only when all of the following are true:

- the caller explicitly marks the target as eligible for catalog replacement;
- the original page and any adapter endpoint are allowed by the published robots policy;
- the live response stays on the submitted domain;
- ordinary identity validation rejects the stale expected identity;
- one unambiguous high-confidence `Product` from structured JSON-LD or an official storefront adapter is tied to the same final product URL and aligned with the live page title;
- the replacement retains its live name, quantity, identifiers, image, and price instead of inheriting contradictory identity fields from the stale sitemap record.

## Scope

- Add an explicit catalog-replacement permission to pre-match enrichment targets only.
- Promote a safely verified live replacement using the existing enrichment response contract so edge recovery remains bounded and validated.
- Replace the stale catalog entry by selected product ID before matching; do not leave both identities in the catalog.
- Preserve a visible audit attribute describing the previous sitemap identity.
- Keep final pair enrichment fail-closed on identity mismatch.
- Validate against real Babanuj pages that currently demonstrate in-place catalog drift.

## Acceptance

- Automated tests prove a structured, same-page live replacement is promoted only with explicit permission.
- Tests prove quantity conflicts and unrelated identities remain rejected when replacement evidence is missing, ambiguous, unstructured, cross-domain, or post-match.
- Tests prove stale quantity and identifiers are not inherited and no duplicate stale product remains.
- The worker/API boundary preserves the explicit permission and the existing edge result sanitizer accepts only the original bounded target ID/domain/source URL.
- A real Babanuj probe recovers current images and prices for the four drifted URLs identified in Task 100 while recording their previous names.
- A fresh report is matched from the reconciled live catalog rather than from stale sitemap identities.
- Build, lint, typecheck, focused tests, and full tests pass.
- Verified Fable 5 returns strict PASS before merge; Fable performs the merge only after Codex verifies the approved deployment.

## Architecture review

Verified Claude Fable 5 (`claude-fable-5`) returned a strict architecture PASS. The approved design requires an explicit pre-match permission, same-page structured-product evidence, page-title alignment, duplicate collapse, an audit trail, edge sanitization, and a hard post-match replacement guard. The implementation follows those boundaries; competitor and final-pair enrichment remain fail-closed.

## Live validation

On 2026-08-03, the bounded real-data probe resolved all four known drifted Babanuj URLs (4/4). Each result contained a current structured product identity, an HTTPS image, and at least one currency-qualified public price. The recovered identities were:

- `Zaitoune Baklava with Honey Special Edition (Kol Shkor) 500g` — USD 46.40
- `Zaitoune Sesame Cookies (Barazek)` — USD 10.80–21.60
- `Zaitoune Mamoul With Walnut 600g` — USD 30.60
- `Zaitoune Baklava Rolls (Mabrouma) 500g` — USD 43.20

The evidence snapshot is recorded in `docs/tasks/101-live-evidence.json`. These are public observations, not fixture values, and may change when the merchant updates its catalog.

The first exact-commit Sites deployment proved the replacement endpoint at 4/4 but exposed a broader coverage blocker: a full Babanuj crawl retained all four stale records because the initial 16-product enrichment wave never selected them. The PR remained draft and unmerged. A first bounded amendment was rejected during implementation review because the preliminary comparison is presentation-truncated and cannot be the selection universe. Fable then approved the honest full-catalog design: plan from the actual primary catalog, prioritize genuine preliminary matches, fill from all remaining price-less primary products, and validate up to 64 URLs once before rebuilding the final comparison. Rival targets remain unflagged. Catalogs beyond the bound receive explicit shortfall coverage and a visible gap.

Sites version 133 deployed reviewed implementation commit `a0ecea45513ab3d26de0d7f5a3b465db994f692e`. After edge propagation, the committed full-crawl harness completed in 33,017 ms with 80 primary products, 60/60 reconciliation pages fetched, no truncation, all four current identities carrying images/prices/audits, and zero stale names. The verbatim output is `docs/tasks/101-live-crawl-evidence.json`. Local-module transport is inapplicable because Babanuj returns HTTP 403 to the local/VPS-class path; the deployed Sites run directly exercises the edge path used for recovery.

## Status

The full-catalog amended implementation is complete locally. Focused tests pass 117/117; the full repository gate passes 490/490 after successful typecheck and production build; lint has no errors (two pre-existing `<img>` optimization warnings). The first strict Fable implementation review blocked manual evidence reshaping, quantity-less duplicate collapse, and ordinary Shopify variant steering; those findings were fixed. Verified Claude Fable 5 returned `TASK 101 IMPLEMENTATION: PASS`, `TASK 101 COVERAGE AMENDMENT: PASS`, blocked the first truncated-row implementation, then returned `TASK 101 FULL-CATALOG AMENDMENT: PASS`, `TASK 101 FULL-CATALOG IMPLEMENTATION: PASS`, and `TASK 101 LIVE EVIDENCE: PASS` for the corrected design, code, and deployed observations. Exact evidence commit deployment, Fable merge, VPS deployment, and persisted fresh-report verification remain pending.
