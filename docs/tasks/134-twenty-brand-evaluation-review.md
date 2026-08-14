# Task 134 review - twenty-brand production evaluation

## Decision

The production workflow is not broadly reliable enough to describe every
successful report as a useful price-comparison report.

- 20 reports were requested: 8 PASS, 8 LIMITED, and 4 FAIL.
- 17 produced report documents. Three failed before a document existed, so
  their catalog metrics are unknown rather than zero.
- The 19-report Starter cohort produced 7 PASS, 8 LIMITED, and 4 FAIL. None of
  the Starter reports produced a direct price delta.
- MyJam was the only Agency report. It passed and produced the cohort's only
  direct price delta, so it is reported separately rather than used to inflate
  the Starter result.
- Wearform's empty-result regression is fixed: 753 products were discovered
  and 17 published candidates had rival prices. The report still fails strict
  review because a sampled comparison conflated primary model J354 with rival
  model J754 and generated a misleading recommendation.

## What worked

- No completed report observed an empty primary catalog.
- Eight reports produced a catalog, verified competitor, and at least one
  rival-priced published candidate without a known integrity violation.
- Every one of the 124 published candidate pairs is retained in the evaluation
  artifact with product names, source URLs, valid prices, assessment evidence,
  and recommendation text.
- Failed executions preserve unavailable metrics as null, and the runner saves
  report IDs and phase changes so interrupted evaluations resume rather than
  create duplicate paid reports.

## What did not work

- Gymshark, Bombas, and Ridge ended in the same production HTTP 400 crawl
  failure and never produced report documents.
- Six completed reports found no verified competitor. Eight completed reports
  produced no accepted rival-priced match.
- Only one report had a direct price delta, and it was the Agency outlier.
  Rival-priced substitute discovery is therefore much more common than actual
  price comparison in this cohort.
- Product identity has not been exhaustively human-reviewed. The sampled
  Wearform model-number conflict proves aggregate price/source validity alone
  is not sufficient to guarantee comparison correctness.
- Image coverage measures the presence of an HTTP(S) image URL only. It does
  not prove the image loaded or depicted the correct product.

## Recommended next tasks

1. Fix the shared crawl-request failure affecting Gymshark, Bombas, and Ridge,
   retaining structured failure evidence and a fallback crawl path.
2. Add a hard identifier-conflict gate for SKU, MPN, model number, GTIN, size,
   and pack count before a match can be published. Re-run Wearform as the
   regression case.
3. Separate rival-priced substitute discovery from direct price comparison in
   the product and UI. Do not recommend price action when the primary public
   price was not observed; instead show an explicit data-collection gap.

## Review record

Claude Fable 5 was requested but returned a session-limit error with reset time
`1:50am Africa/Cairo`; no Fable verdict was produced and none is claimed.
Two independent Codex reviewers blocked the first artifact because failed runs
were represented as zero metrics, pair-level evidence was absent, validation
was weaker than production, run resumption was incomplete, the Agency outlier
was aggregated with Starter, and the Wearform identity conflict was hidden by
the aggregate PASS. Subsequent reviews also found and drove fixes for
self-declared source domains, ungrounded direct-price counts, non-atomic
checkpoints, terminalized local polling errors, and cross-competitor match-slot
evidence. Both independent reviewers returned PASS with no blocking findings on
implementation head `a67edfe73fe04ef0328b1c7b25902728fcd0252b`. The draft PR
remains unmerged because the required Fable gate is still unavailable.
