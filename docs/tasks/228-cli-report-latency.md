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
