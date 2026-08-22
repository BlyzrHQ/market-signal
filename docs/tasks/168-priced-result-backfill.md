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
- The subsequent exact-head review found that backfill priority still counted stale, cross-market, or cross-currency prices, terminal replay ignored the evidence hash, and retry-time observation drift could change an otherwise identical fact manifest. Backfill priority now requires fresh first-party same-market/same-currency price evidence, terminal replay binds the exact completed manifest, and relational facts use the report's stable observation timestamp across retries.
- The latest exact-head review found recovery ownership, target-market priority, final-enrichment accounting, action-plan determinism, and terminal replay identity gaps. Recovery now atomically adopts an immutable completed fact snapshot for the new attempt; matching priority is bound to the persisted report timestamp and inferred target country; non-product price gaps cannot be counted as scheduled enrichment; action text remains presentation-only and cannot change relational fact identity; and terminal replay validates attempt plus entitlement before returning.
- Two fresh reviews of head `ac549b1` blocked the remaining 80-of-1,000 screening cap, permissive unknown-market publication, retry-time enrichment timestamps, missing recovery ownership for judge checkpoints, attempt-agnostic document/evaluation manifest reads, and replacement of real source observation times with the report timestamp. The revision screens the entire bounded primary catalog, requires affirmative target-market evidence on both sides, plans enrichment against the stable report timestamp, adopts judge checkpoints during recovery, binds document/evaluation reads to the active attempt, and separates real `observedAt` provenance from the stable snapshot timestamp used for retry hashing.
- A final audit found a second hidden cutoff: final price-page enrichment still stopped after 160 pages for a 20-result report. The revision now allows enrichment to exhaust the full 1,000-page bounded pool, so a valid candidate later in the catalog can backfill an earlier unpriced or rejected pair.
- Two exact-head fallback reviews then blocked a two-candidate retrieval ceiling, a 1,000-page enrichment ceiling that could cover only 500 two-sided pairs, retry-time candidate drift, permissive unknown-market publication, and false exhaustion when primaries had no viable candidates. The revision now considers five rivals per primary, persists a compact catalog-bound candidate plan for deterministic retries, counts every synchronized primary as screened, fails publication closed without affirmative target-market proof, and processes bounded enrichment in waves until the 20-result target is filled or all 6,000 planned pages are exhausted.
- The compact 1,000-primary by five-candidate plan is approximately 309 KB, below the 512 KB durable checkpoint limit. Its hash includes product domain, ID, source URL, normalized name, canonical quantity, report timestamp, market, limits, and pins, so changed catalog identity invalidates replay.
- Focused regressions prove that only 20 relational matches remain price-eligible while all screened evidence is retained, differing completed facts fail closed without a terminal document write, processing failures never claim exhaustion, and secondary rivals receive price-enrichment capacity.
- Focused regressions also prove stale positive prices are re-fetched and partial or concurrently finalized fact snapshots cannot be terminalized under an empty binding.
- Prior exact-head validation: all 930 tests passed; production and VPS builds passed with both packaging assertions; lint had zero errors and two pre-existing image warnings; CLI Go tests and vet passed.
- Two fresh reviews of head `e56ceaf` blocked premature collapse of accepted backup candidates, swallowed candidate-plan and judge-checkpoint failures, missing durable enrichment-wave replay, incomplete runtime accounting, false exhaustion for no-candidate primaries, and skipped re-enrichment of publication-ineligible market/currency pairs. The revision retains accepted backups until final priced selection, fails durable plan/checkpoint operations closed, persists each enrichment wave under an exact input hash, budgets checkpoint and fact callbacks, tracks processed primaries independently from assessed candidates, and re-reads both sides of any pair that cannot yet pass the final market/currency publication gate.
- Candidate-plan identity now includes the complete retrieval-affecting product evidence, embedding model and dimensions, canonicalized required URLs and pins, and an explicit plan-algorithm version. Enrichment checkpoint replay validates the exact input hash, bounded coverage, and product shape before reuse; conflict or corruption is a visible incomplete-enrichment state.
- Current exact-worktree validation: all 939 tests pass; production and VPS builds pass with both packaging assertions; lint has zero errors and the same two pre-existing image warnings; CLI and contract Go tests plus vet pass. The suite includes explicit five-candidate and accepted-backup retention, no-candidate processed coverage, deterministic candidate-plan replay and failure handling, 1,000-primary screening, cross-market re-enrichment, authenticated durable enrichment-wave replay, checkpoint-conflict rejection, same-market publication, and wave-based enrichment regressions. Fresh independent exact-head reviews are still required after the final commit.
