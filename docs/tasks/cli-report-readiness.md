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

## Exact-head review and first acceptance (2026-09-05)

Strict Fable 5 review, canonical `claude-fable-5-1`:

- `925f0c09e01e3d1869a87b106e4c809aa29273cf`: session
  `aca73b9a-3ba9-4306-9366-c90066472d72`, PASS for an unpromoted test deployment
  and one 20-comparison acceptance report only.
- `c64605f2b57bebf2a2edccfc75ac69d827fdaf34`: session
  `62368ed9-6d1f-4c5f-a28c-59d6a478f918`, PASS for the same bounded scope.
  Neither review authorized promotion, merge, or a readiness claim.
- Independent full suite at c64605f: 1,387 PASS; CI validation and the six-platform
  CLI artifact build both passed. Artifact workflow run `33983578656`.

Trigger deployed exact c64605f as **20260905.6**, deployment `2kz09508`
(`deployment_it7yktmc6py5xzeit18ek`), verified DEPLOYED at
2026-09-05T18:16:53.272Z. This remains unpromoted: the current worker was verified
as 20260902.1 / `ff36426bf68b6207e855626ab876a81d476585fe`.
Test image digest: `sha256:b709e53e62f7d356b7c834fc19e0c2f37083630563a461112bbc6152c34199f1`.
Capabilities run `run_06g75joqere7oorpa6psq02p01` completed on 20260905.6,
provider configured, no website required, optional analysis supported.

One report was submitted, not retried as a new logical request:

- Domain: `teapigs.co.uk`; 20 comparisons, maximum 5 rival sellers,
  `includeAnalysis: false`.
- Request: `five-domain-readiness-teapigs-v6-20260905`.
- Run: `run_06g75jsbpb3remr611gr0lqg01`, COMPLETED / **limited**, not success
  against the requested coverage target. Created 18:23:19.532Z; finished
  18:27:19.679Z. CLI returned automatically in **249.560 seconds**, exit 2.
- 13 catalog records; **6 priced comparisons / 6 primary products / 5 rivals**.
  All six have finite positive prices on both sides in GBP. This does not
  establish equivalent pack size or certify an exact-product match.
- 13 completed search receipts, zero unknown receipts and zero in-flight paid
  calls at terminal. Standard-rate usage estimate **USD 0.35511995**; Trigger
  reported **0.289207125 cents** (USD 0.00289207125) compute. These are not a
  settled provider invoice. The report's actual `costMicrousd` remains unknown.
- No paid AI action planning and no rival website scoring were performed.
  The output explicitly marks those optional sections as not requested.

| Primary product | Primary GBP | Rival result | Rival GBP | Assessment |
| --- | ---: | --- | ---: | --- |
| Silver tips white tea | 6.49 | AN&C Ceylon Silver Tips White Tea 10g | 10.99 | Same general tea type; primary pack amount not established |
| Mao feng green tea | 11.49 | Coffee Supplies Direct Birchall loose leaf 750g | 8.99 | Pack/variant equivalence unverified; no savings claim |
| Kinto Unitea one touch teapot | 29.99 | Kinto UNITEA one touch teapot 460ml | 28.00 | Strong name/brand match; primary capacity still needs verification |
| Teapigs loose leaf tea infuser | 8.99 | True Tea two-handle infuser 7.5cm | 6.80 | Functional alternative, not an exact-item claim |
| Decaf English breakfast tea | 7.49 | Climpson & Sons Tea Drop decaf | 27.00 | Same tea type; pack sizes not normalized |
| Kinto Unitea glass cup | 12.99 | True Tea Wilson mug with infuser and lid 350ml | 29.99 | Different construction/accessories; weak like-for-like comparison |

**Acceptance failed:** neither 20 useful comparisons nor 120-second delivery
was demonstrated. Keep this PR draft and the worker unpromoted. Do not claim
that increased crawl coverage alone makes the product ready.

## Follow-up defect isolated without another AI report

The initial match completed in 38.649 seconds, but final enrichment repeatedly
failed a two-page batch across ten bounded task attempts. Its saved plan has
one ordinary `/products/` rival URL and one primary `/p/` URL. The final handler's
`publicProductTarget` parser still dropped `/p/` even though crawl and primary
price recovery now accept it. The resulting one-target response failed durable
validation against the original two-target plan, blocking the quality-repair
path and causing repeated task retries. Searches were checkpointed and NOT
re-billed by those retries.

Fixed that remaining parser mismatch without weakening same-domain, protocol,
price, or durable batch-identity checks. Regression coverage now includes both
single and mixed route batches, off-domain/non-HTTP rejection, and the actual
handler-to-durable-validator boundary.

Reconstructed the exact two saved targets locally and matched both SHA-256
target hashes to the persisted plan before fetching. A script-only public-page
replay returned both priced products, no gaps, and a valid durable result in
**2.028 seconds**. This is evidence for this enrichment fix, not a fresh report
or proof that 20 comparisons can now finish within two minutes. No second paid
report was submitted. The original customer-visible result was not modified.

Post-fix independent full suite: **1,390 tests PASS**, including application and
Node typechecks and production build. Final lint/direct-worker typechecks and
exact-head review are required before deploying this follow-up.
