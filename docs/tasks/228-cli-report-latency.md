# CLI report latency and useful comparison coverage

## Request

Deliver 20 useful priced comparison pairs in at most two minutes, investigate the
22-minute Musa & Palm report and its five-pair shortfall, and make the report
command show progress and deliver its output without requiring a separate wait.
At most ten live domains are authorized. A total provider-spend cap has been
requested; begin with offline diagnostics and existing-run evidence.

## Scope

Stacked on `codex/trigger-workflow-parity` (PR #227), starting at
`ac1a13d74e13f5ec2bdbefcad945820cb65c0e5f`. No website/VPS deployment or outer
coding-agent loop. Test any worker changes on an explicitly pinned unpromoted
Trigger version. Never equate an early receipt or partial result with meeting
the completed 20-pair target.

## Baseline evidence

- Musa & Palm `run_06g731ra892lspufg4p78jle01`, worker `20260905.2`:
  report duration 1,340.016 seconds; 47 catalog products; 5 of 20 comparisons;
  quality counts 3, 4, 5, 5 after three repair rounds; cost unknown.
- Graza `run_06g6tvclkrh0r6a2aejr1k0e01`: 1,403.517 seconds; 18 of 20 pairs.
- Existing `report` waits by default. Prior instructions used `--no-wait`;
  progress during default waiting is currently missing.

## Validation and review

## Investigation and implementation

- Trigger started Musa 251 ms after submission. Its 247 state revisions each
  previously implied a child snapshot task, metadata flush, and read-back.
- Direct product searches were serial, followed by repeated three-minute repair
  passes, serial AI action batches, and two-at-a-time rival benchmarks.
- The rival cap admitted individually priced PKR/USD candidates before pair
  currency validation, consuming slots that were later removed at publication.
- Existing Musa checkpoint evidence contains 29 distinct priced URLs: 25 SAR,
  one PKR, two USD, one EGP. The SAR URLs span 22 domains. Even a perfect
  five-domain allocation of that evidence has an eight-URL upper bound. This is
  candidate coverage, not a semantic quality endorsement of those eight pairs.
- Enrichment logged 36 identity mismatches, including URL-slug/title mismatches.
  Other gaps: six currency, ten HTTP/access, three robots, two market redirects.
- Wearform's existing run finished limited at 11/20, with 755 catalog products
  (`run_06g72mgv61g6j47cn9i70qjh01`, completed 12:33:05.630 UTC). Catalog size
  alone does not establish useful comparison coverage.

Changes: direct-only eight-wide search waves; deterministic evidence-ranked
seller selection after currency validation; coalesced concurrent state writes
with commit read-back before any paid call; observed page title preferred over
slug; bounded direct search tool chaining/output; repair exclusions and selected
seller search scope; four-wide action drafting/five-wide rival benchmarking;
provider usage and stage-timing receipts; automatic CLI progress on stderr.
All started wave operations are drained on failure; no subsequent wave launches
after uncertain provider/state outcomes. No price, robots, or source checks are
relaxed. Website scheduling defaults remain unchanged.

Fable architecture review: verified `claude-fable-5-1`, session
`2abb12a5-8638-4b6c-adc6-57688d825843`. It confirmed serial searches, snapshot
overhead, seller lock, and repeated repair work. Its suggestion to combine an
operation's start and completion into one write was rejected: intent must be
durable before spending. Concurrent starts and concurrent completions may each
share a write, with every caller awaiting the confirmed commit. Global rival
URL uniqueness and feedback-bound repair keys are retained.

Independent validation so far: full `npm test` (build/typechecks and 1,368 tests)
passed; Go tests/vet/build passed. Additional focused tests pass after the repair
scope changes. Default lint sees pre-existing generated `.trigger/tmp` bundles;
source lint with `--ignore-pattern .trigger` passes with one existing UI image
warning. Final exact-head review and live timing/coverage acceptance are pending.
The 120-second target is **not yet proven**. Do not call this task complete until
the pinned worker is measured on real public domains.

## First pinned acceptance run (failed target)

Head `c7eaa9bd8c7cb4407d5464c02ac1cda3abdaa332`, unpromoted worker
`20260905.3`, deployment `0g3xcvy3`, Fable code-safety PASS from verified
`claude-fable-5-1` session `b9e51a41-9d82-4eb4-975c-86a52a305746`.
Independent full suite: 1,370 passing tests; Go tests/vet/build and source lint
passed. PR #228 Contributor validation passed. No promotion or merge.

Musa run `run_06g73mf7f8kilqcue4ihhh1q01` completed limited: 6/20 pairs,
5 sellers, 47 catalog items (25 priced). CLI wall time 353.700 seconds,
internal report time 319.890 seconds. Trigger started after 250 ms. There were
49 searches and 51 recorded provider receipts. Usage-derived OpenAI standard
price estimate: USD 1.73568615 (not settled billing); Trigger compute reported
0.479773125 cents. The older report's AI bill is unknown, so no cost-saving
percentage is claimed. Only one fresh paid domain run has been started so far.

All three repair passes returned transport-failed. Code inspection found a race
introduced by concurrent searches: fallback checkpoint allocation selected the
same first-free slot while earlier writes were pending. Reserve the slot before
awaiting persistence; retain all paid-operation intent/replay protection.
Additional corrections filter unpriced primaries before forming search waves,
retain up to six source-backed structured leads instead of clipping them to one,
and use a compact URL/title response schema with an explicit multi-result prompt.
No unpublished source URL becomes a verified fact without live page/price checks.
The automatic CLI polling interval is reduced from 15 to 5 seconds; progress
messages remain throttled and stdout remains a single final JSON object.

Corrective head `f0faf70aede55894f87e0109c07c4dac6f4c16a8`: verified Fable
`claude-fable-5-1` session `2b9faeea-a452-40b0-9dc0-d9b0358a5e6d` returned
strict code-safety PASS for a pinned unpromoted acceptance run. Independent
suite: 1,373 passing tests, Go tests/vet and source lint passed.

Further critical-path improvement under review: for small state, persist the
whole compressed state in one run-metadata value and verify the exact packet
through management-API read-back. The first pilot's final packet was 213,882
bytes. Trigger documents a 256 KiB metadata limit; use a 224 KiB total-object
threshold including unrelated metadata, with the unchanged child snapshot
path for larger state. Never fall back after an ambiguous inline commit.
Legacy child pointers remain readable; every paid start stays durable before
the provider is called. Reference: https://trigger.dev/docs/runs/metadata.

Inline-state review: verified `claude-fable-5-1`, session
`bef8a868-6bf2-4858-af1a-dd7f07155ecb`, PASS for pinned unpromoted acceptance.
Its key-order robustness observation was applied: compare canonical hashes of
the complete inline packet, with reordered-key and corruption regression tests.
Full suite at inline-state head: 1,375 passing; direct-worker TypeScript passed.

## Second pinned acceptance run (stopped; target failed)

Worker `20260905.4`, source `7e87ca3814ac49a91b98ee6692b6d34bebb1acce`,
deployment `alxzeqyh`, reviewed PASS by verified Fable session
`aa358ca8-b463-4d87-be67-fbbce67c9b61`. CI passed. Run
`run_06g743dvi8omvo72sb1f0ana01` started after 255 ms. Crawl completed after
42 seconds; 25 searches and first enrichment finished by about 100 seconds.
Inline state read-back worked. It then retried identical enrichment because
the plan marked 9 eligible records, 8 schedulable, as processing-incomplete.
This was not a simple eight-page budget: an unschedulable record made the plan
truncated. Repeating it cannot make progress. The owned pilot was canceled and
confirmed CANCELED, with zero in-flight paid operations. Search receipts stayed
at 25 across retries; usage-derived OpenAI estimate USD 0.83140820. No new paid
searches were launched by those task retries. Total known estimate across both
fresh pilots: USD 2.56709435, not settled billing.

Read-only retrieval of three already-paid OpenAI responses showed the returned
URLs were the primary domain's own pages. They were correctly rejected, but the
search prompt did not explicitly exclude the primary and insisted on proprietary
names. Correct the direct query instructions to exclude the domain, use observed
contents/type/size, and request other businesses. Recognize bounded Salla
`/<slug>/p<digits>` item routes as private leads, still requiring page checks.

For direct research, distinguish nonretryable coverage gaps from transient
enrichment failure. Retain the visible truncated-coverage flag, but let the
quality loop repair terminal/unschedulable gaps rather than retry the identical
whole task. Undefined legacy retryability and transient failures keep existing
retry semantics. Regression coverage includes a real orchestrator fixture that
repairs an unschedulable gap to 20 priced pairs within the same task attempt.

## Handoff / review blocker — 2026-09-05 15:18:49 UTC

Latest implementation head: `ecd5932c757d550e8bbfa485f5c61999b977d6a0`.
Independent full npm build/typechecks and 1,378 tests passed; explicit direct
worker TypeScript check and source lint passed. PR #228 Contributor validation
passed at this code head. Go tests/vet had passed after the last CLI changes.

Final Claude review failed before model execution: category authentication,
exact sanitized message `Failed to authenticate: OAuth session expired and could
not be refreshed`, session `d093a6da-f55a-4c2f-abbe-b849419e8990`. Read-only
`claude auth status --json` confirmed `loggedIn: false`, `authMethod: none`.
This is not a capacity/quota error, so the configured Codex review fallback does
not apply. The claude-delegate skill/repository gate blocks rollout until login
and exact-head review. No API credential substitution or silent model fallback.

PR #228 remains draft, unmerged. Latest deployed test version is `20260905.4`
at `7e87ca3814ac49a91b98ee6692b6d34bebb1acce`, deployment `alxzeqyh` (unpromoted).
The latest self-domain/retry fixes are NOT deployed. No VPS/Sites deployment,
default worker promotion, or replacement of the user's installed CLI occurred.
Updated tested CLI binary is `C:/tmp/marketsignal-trigger-latency.exe`, version
`ecd5932c757d550e8bbfa485f5c61999b977d6a0`, with automatic progress and default
waiting; its backend changes are not ready for user acceptance yet.

All live work launched in this task is terminal: first pilot completed limited,
second was explicitly canceled. Do not resubmit their request IDs or present
them as 20-pair successes. The two-minute/20-useful-pair target is NOT achieved.
Next: restore Claude subscription login, strict exact-head review, pinned
unpromoted deployment, one same-domain 20-pair/5-rival test with timing/receipt
inspection, then representative domains within the authorized ten-domain bound
only if that acceptance improves. Keep broad rollout blocked until proven.

## Resumed five-domain acceptance — 2026-09-05

The user restored the Claude subscription login and explicitly requested five
additional domains. No source changes were made for this batch. The initial
review session `75b565db-b594-4bda-a313-c91c5866a33e` reached its local turn limit
without a verdict; it is not counted as approval. A fresh, bounded review by
verified `claude-fable-5-1`, session `9bdf3679-8659-4a23-8a4a-14154b307085`,
returned strict PASS on exact head `60ba80ccda59fda15aec848f1a7cc43775794152`
for an unpromoted deployment and five 20-comparison live tests only. It did not
approve merge, promotion, or the two-minute SLO. Its nonblocking observation was
that prompt-level subdomain exclusion is stricter than the existing canonical
domain-equality publication check; that pre-existing limitation is retained.

Independent current-head CI passed; 272 focused regression tests passed again.
The earlier full build/typechecks and 1,378-test suite remain valid because the
only subsequent commit was documentation. No model API credentials were used for
the subscription-backed Claude review; its displayed list-equivalent cost is
not included in report-provider estimates.

Unpromoted deployment `20260905.5`, deployment ID `xet38ckn`, source above,
image digest `sha256:3f520652b798f6475e2a802464962a0c873e2fa8156b0f248e4e01c74d534dab`.
Deployment URL: https://cloud.trigger.dev/projects/v3/proj_ywbhdpqswzbwqoudftcf/deployments/xet38ckn
Pinned capabilities run `run_06g74g3gm6h2sci9a7lg78cf01` completed and returned
ready, providerConfigured true, the expected direct tasks, and version 20260905.5.
No website/VPS deployment, default-worker promotion, or installed-CLI replacement.

Batch: Huel, Native, Blueland, Stanley, and Teapigs. Each gets one logical CLI
report request for 20 priced comparison pairs and a maximum of five rival sellers.
Run sequentially, retain original output, inspect usage, and do not automatically
resubmit failures. The report command waits and prints progress by default.
Results and data-quality observations follow below when terminal.

## Five-domain outcome

All five original requests are terminal, with no duplicate submissions and no
in-flight paid operations in their final receipts. The full comparison tables
and original-output locations are in [the acceptance results](228-five-domain-results.md).

| Domain | Trigger run | Priced pairs | CLI seconds | OpenAI standard-price estimate |
| --- | --- | ---: | ---: | ---: |
| huel.com | run_06g74g5fet272sg5hj89f69m01 | 0/20 | 6.416 | $0.00000000 |
| nativecos.com | run_06g74g8p4jpfmj1d1r59oe1m01 | 20/20 | 427.518 | $2.24701790 |
| blueland.com | run_06g74i1pk5e533tn5nuck65c01 | 13/20 | 100.577 | $0.27193355 |
| stanley1913.com | run_06g74imm4c4pqjdmcf58tuif01 | 12/20 | 351.879 | $1.13940125 |
| teapigs.co.uk | run_06g74k8mf4fffubvprja06fb01 | 0/20 | 11.614 | $0.00000000 |

Total recorded OpenAI estimate for this five-domain batch: **$3.65835270**,
derived from 129 completed model-call receipts (117 product-search operations
and 12 action-provider operations), with zero unknown receipts. This is not a
settled invoice. The five report runs separately recorded **2.637252 cents** of
Trigger compute ($0.02637252); this excludes the capabilities check and build.
Huel and Teapigs did not start any paid AI searches. No independent evaluation
pilot was launched. These report tests are separate from the daily feedback
monitor's evaluation-cost ledger and its $0.10 pilot limit.

All 45 returned pairs have finite positive prices on both sides, matching
currencies, and no self-domain pairs. That is an integrity check, not proof of
semantic equivalence. Native's 20 rows represent eight distinct primary
products. Blueland's 13 rows represent two; Stanley's 12 represent seven.

Acceptance is **NOT met**: zero of five runs delivered 20 useful pairs within
120 seconds. Native reached the numeric target after one repair round, but
its sunscreen-to-shower-oil/body-wash/face-set rows are clear semantic concerns.
Blueland pairs multi-item kits with individual cleaners/refills without unit or
contents normalization. Stanley has useful same-capacity alternatives but also
36 oz versus 32 oz comparisons; seller authenticity is not independently proven.

Observed remaining failures:

- Huel's crawl returned five unpriced collection/category entries; Teapigs
  returned one unpriced subscription/category entry. Neither reached product
  search. They are zero-result failures, not fast successes.
- Stanley's three quality-repair rounds all logged `transport-failed` and
  added no comparisons. The exact underlying transport failure is not yet
  diagnosed. Blueland's three repairs completed but still ended at 13 pairs.
- Native spent about 73 seconds on crawl, 193 seconds on initial matching,
  30 seconds on repair, 16 seconds on actions, and 61 seconds on rival website
  scoring. Stanley's rival scoring alone took about 69 seconds. These optional
  scoring stages remain on the critical path before CLI delivery.
- Native's initial priced candidates spread across many sellers; the five-seller
  constraint left 13 initial pairs despite a much larger overall candidate pool.
  The test cap was intentionally unchanged across all five reports.

Next engineering work should address primary product-page recovery, the remaining
repair transport failure, and product-type/bundle/size compatibility, then move
nonessential scoring off the initial-result critical path. These are findings,
not changes implemented in this acceptance batch. Keep PR #228 draft/unmerged
and worker 20260905.5 unpromoted; do not claim the speed/quality task is complete.
