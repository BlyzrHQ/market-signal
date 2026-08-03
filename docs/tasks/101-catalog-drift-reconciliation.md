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

## Status

Implementation complete locally. Focused tests pass 114/114; the full repository gate passes 487/487 after successful typecheck and production build; lint has no errors (two pre-existing `<img>` optimization warnings). The first strict Fable implementation review blocked manual evidence reshaping, quantity-less duplicate collapse, and ordinary Shopify variant steering; those findings are fixed and covered by tests. Verified Claude Fable 5 returned `TASK 101 IMPLEMENTATION: PASS` on strict re-review. PR, approved deployment, and fresh-report verification remain pending.
