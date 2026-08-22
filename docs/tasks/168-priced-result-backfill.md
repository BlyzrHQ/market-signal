# Priced result backfill

## Problem

The live MyJam Agency report `4a9a78f9c4a442cea8d19cf21d2d224e` discovered 1,001 primary products but treated the 20-product entitlement as a pre-publication judge cap. Nine of the 20 accepted semantic pairs were later suppressed for missing valid prices, leaving only 11 publishable comparisons.

## Product contract

- A report product limit is a target for publishable, source-linked, same-market comparisons with finite positive supported-currency prices.
- Matching may screen a larger bounded pool to backfill rejected or unpriced candidates.
- Final customer-visible accepted comparisons must not exceed the persisted product limit.
- If the bounded catalog and search pool cannot fill the target, the report must expose the exact shortfall and evidence-backed exhaustion state.
- Price, market, source, and identity safety gates remain unchanged.

## Implementation

- Expand the internal matching pool independently from the customer-visible result target.
- Prefer candidate groups whose primary and rival records already contain valid public prices.
- Increase final enrichment capacity enough to cover backfill candidates.
- Apply the strict price publication gate, then retain the strongest publishable comparisons up to the persisted target.
- Record screened, published, target, and shortfall metrics separately.
- Update the product report metric to describe publishable compared products rather than pre-publication attempts.

## Validation

- Regression tests for candidate pool sizing, priced candidate priority, publication capping, and shortfall metadata.
- Matching route, lifecycle, orchestration, report UI, full test, lint, and build validation.
- Fresh live MyJam paid-plan report proving 20 publishable priced comparisons selected from the catalog-backed screening pool, or an explicit bounded-exhaustion shortfall if the public market truly cannot supply 20.

## Data boundaries

Only attributable first-party public product pages may be published. Search or model output remains discovery/inference and cannot bypass price, source, market, currency, or identity validation.

## Review and validation record

- The installed Claude Code `2.1.238` launcher resolved to Bun `1.4.0` before model selection, so no Claude or Fable review was claimed.
- The required high-risk Codex fallback used two independent, read-only reviewers on the exact PR head.
- The initial fallback reviews blocked hidden target clamping, repeated-rival enrichment that could starve distinct primary products, stale fact-manifest reuse, deleted suppressed evidence, and misleading assessed-versus-published metrics. The revision keeps the purchased target intact, funds at most one completable rival per primary before optional work, reuses facts only when the current manifest ID and hash match, persists the full screened evidence set for evaluation, and labels the customer-visible count as priced products compared.
- The second exact-head fallback review found that screened matches beyond the target could remain price-eligible in the relational API and that a changed retry bundle must not silently reuse a completed stale fact manifest. The revision marks unselected screened rows as evidence-only with `outside-result-target`; exact completed manifests are reusable, while a differing immutable manifest now stops orchestration before replacing authoritative facts or saving a mismatched presentation.
- The next fallback review blocked premature deletion of an authoritative manifest, inaccurate exhaustion wording, and one-rival-only final enrichment. The revision keeps completed facts immutable, distinguishes a fully processed bounded-pool shortfall from incomplete matching/enrichment, and spends remaining price capacity on secondary accepted rivals before presentation images.
- A further exact-head review found a concurrent manifest-finalization race, partial page coverage being treated as complete, and screened count falling back to assessed count. Document persistence now carries an exact expected manifest hash through the worker callback and enforces it with a database CAS; partial page fetches or page-level gaps are limited processing states; and the matcher persists the selected bounded-pool count independently.
- The latest exact-head review found that callers could omit the manifest binding, partial fact artifacts could still be overwritten by an empty binding, and stale positive prices could bypass enrichment before being rejected at publication. The manifest binding is now mandatory end-to-end, an empty binding requires no manifest or chunks, concurrent finalization is guarded atomically, and enrichment applies publication-equivalent source and observation-freshness checks.
- Focused regressions prove that only 20 relational matches remain price-eligible while all screened evidence is retained, differing completed facts fail closed without a terminal document write, processing failures never claim exhaustion, and secondary rivals receive price-enrichment capacity.
- Focused regressions also prove stale positive prices are re-fetched and partial or concurrently finalized fact snapshots cannot be terminalized under an empty binding.
- Final validation: all 923 tests pass; production and VPS builds pass with both packaging assertions; lint has zero errors and two pre-existing image warnings; CLI and contract Go tests and vet pass.
