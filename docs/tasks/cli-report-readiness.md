# Internal CLI report readiness

Branch: `codex/cli-report-readiness`, stacked on PR #228.

## Scope

Fix the failures measured in the five-domain acceptance batch without changing
the deployed website: invalid quality-repair feedback, missing primary product
pages, obviously incompatible alternatives, and optional analysis latency.
Comparison targets count priced primary/rival pairs, not catalog entries.
Do not weaken price, currency, source, or durable no-rebill boundaries to hit a
numeric target. The 20 useful pairs / 120 seconds acceptance remains unproven.

## Evidence and decisions

- Existing Stanley run `run_06g74imm4c4pqjdmcf58tuif01`: all three saved repair
  requests contain the same primary ID twice. Replaying their parser locally
  reproduces `Report quality repair feedback must be deterministic and unique.`
  These were incorrectly summarized as transport failures; no search was started.
- Huel and Teapigs returned unpriced collection/subscription records, not a
  priced product catalog. Saved acceptance evidence is in task #228.
- Native reached 20 rows but included sunscreen versus shower oil/body wash.
  Price presence does not establish comparable product function or bundle size.
- Fable architecture review (canonical `claude-fable-5-1`, session
  `b2df418a-0aa0-49bb-a70b-6af860a9c760`) recommends an explicit, persisted
  direct-CLI mode for optional AI actions and rival website scoring. Preserve
  comparison/competitor facts and existing paid-operation keys. This was a
  recommendation, not a strict implementation review or test result.

## Validation and rollout

Implemented: unique/conflict-safe repair IDs, bounded two-hop product discovery
within the existing five-HTML-page budget, short `/p/` routes and numeric-ID
titles, HTML-link candidates admitted to primary price verification without
requiring a Shopify adapter, named ProductGroup variants (each uses its own
offer, with the page actually observed retained as source), optional analysis
bound to request identity, and a conservative direct-CLI contradiction screen.
That screen is not an independent semantic evaluator; unknown functions and
incompletely specified quantities remain uncertain.

Fable crawl diagnosis (`claude-fable-5-1`, session
`02fe0a96-6cd0-4cd5-9dd9-6f9264ac3ac7`) identified the short-route defect.
Its proposed subdomain-policy expansion was NOT adopted: independent apex
testing found Huel robots/homepage reachable; preserving same-host safeguards
and parsing observed product variants recovered prices without widening access.

Script-only real public validation on 2026-09-05 (no AI requests):

- Teapigs: 7 priced records in 16.567 seconds, versus zero in the prior report.
- Huel: 10 priced records in 12.640 seconds, versus zero in the prior report.
- These are crawl/price checks, NOT completed 20-comparison reports.

Independent checks: full npm test (typechecks, build, 1,387 tests) PASS; direct
worker TypeScript check PASS; source lint PASS with one pre-existing image
warning; Go tests/vet PASS. Further edits require relevant revalidation.

ProductGroup boundary reference:
https://developers.google.com/search/docs/appearance/structured-data/product-variants

Use saved evidence and offline regression fixtures first. Then independently
run the relevant/full checks, obtain exact-head strict review, deploy a pinned
unpromoted Trigger worker, and run bounded real acceptance. No website deploy,
promotion, broad paid retest, or claim of readiness before measured validation.
Provider receipts are usage evidence, not a settled bill. Unknown cost is not zero.
