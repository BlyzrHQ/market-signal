# Task 109 — Deep-catalog product matching

## Goal

Extend product matching from the current bounded 60 primary products per report
to a safe technical ceiling of 1,000, so the proposed Growth and Agency catalog
allowances can eventually be delivered without one oversized AI request or a
whole-catalog retry bill.

This task builds the backend capability. The default production entitlement
remains 60 until paid workspace entitlements and measured cost gates exist.

## Current constraints

- Sitemap extraction stops at 600 product records.
- `/api/match` accepts at most 600 products per catalog.
- AI matching selects at most 60 primary products and has a 45-second total
  budget.
- Trigger gives one matching HTTP operation 90 seconds and retries the whole
  matching operation when coverage is defective.
- One AI call enforces rival uniqueness only inside that call.
- The public report snapshot retains at most 100 comparison rows, although
  relational fact persistence can retain the complete accepted match set.

Changing `60` to `1000` would therefore create deadline failures, duplicate
rival assignments, repeated embedding/judging cost, and untruthful coverage.

## Design

### Bounded plan

- Discover and preserve at most 1,000 primary catalog products.
- Select the entitled number deterministically and embed the selected primary
  and rival catalogs exactly once per matching operation.
- Keep one authenticated `/api/match` request for the complete selected
  catalog. Inside the matcher, split only the AI judge work into deterministic
  batches of at most 25 candidate pairs.
- Process judge batches with bounded concurrency. Retrieval and the final
  assignment remain global so a rival product cannot be assigned to multiple
  primary products merely because they were assessed in different batches.
- Give each absent judge batch one initial request. A worker retry replays
  completed checkpoints and requests only missing batches; configured-
  unavailable AI is never retried.
- Stop starting new work at the report-level matching deadline or spend/call
  budget. Preserve completed batches and expose the remainder as unassessed.

### Durable checkpoints

Create `report_match_batch_checkpoints`, keyed by report run, report attempt,
batch index, and deterministic input hash. The hash binds the model, prompt
contract, selected catalog identity, and bounded judge payload. A completed
checkpoint stores the bounded judge result and its result hash.

On worker retry:

1. Recreate the same deterministic batch plan.
2. Reuse a checkpoint only when report attempt, batch index, batch count, and
   input hash match.
3. Re-run only absent or conflicting batches.
4. Never accept a checkpoint belonging to another report attempt or catalog
   input.

Checkpoint writes are authenticated internal operations, idempotent for equal
content, bounded by byte size, and purged with their report.

### Composition

- Compose all usable judge batches into one `ProductComparison` after global
  retrieval and before the global rival assignment pass.
- Count each primary ID once across selected and assessed sets.
- Sum calls, retrieval pairs, embedding calls, duration, and candidate slots.
- Enforce rival-product uniqueness across the complete result in the existing
  final assignment pass.
- Recalculate assigned/verified counts after global deduplication.
- Keep explicit batch totals, completed batches, reused checkpoints, selected
  products, assessed products, and unassessed products in matching metadata.
- A partial deep-catalog run is `limited`, never silently `complete`.

### Persistence and presentation

- Persist the complete accepted match set to relational report facts before
  compacting the public presentation snapshot.
- Preserve total, persisted, and truncated row counts in the snapshot.
- Do not claim that all 500/1,000 rows are visible in the current table.
- A follow-up task must expose relational matches through bounded pagination so
  customers can inspect/export every persisted accepted comparison.

### Entitlement safety

- Add a server-controlled `MARKET_SIGNAL_PRODUCT_ANALYSIS_LIMIT`, clamped to
  `1..1000`, with a default of 60.
- Do not accept a product limit from the unauthenticated public request.
- Paid workspace entitlements will replace the deployment-wide setting in the
  billing task. Growth/Agency limits are not advertised until that exists.
- Keep Sites on the default 60-product ceiling. Limits above 60 require the
  direct VPS/Caddy worker path and its longer request deadline.
- Scale the matcher budget by selected catalog size: 45 seconds through 60
  products, 360 seconds through 500, and 720 seconds through 1,000. Keep the
  Trigger task ceiling and stale-run deadline above the bounded critical path.

## Validation

- Unit tests cover deterministic 1,000-product selection, bounded 25-pair judge
  batches, one embedding pass, global rival deduplication, aggregate coverage,
  replay without repeated judge calls, and partial gaps.
- Route tests reject oversized/untrusted controls and accept a 1,000-product
  primary catalog only through the server-controlled plan.
- Orchestration tests prove checkpoint reuse, stale-checkpoint rejection,
  deadline behavior, and truthful limited status.
- Store tests cover checkpoint idempotency, conflicts, byte limits, attempt
  binding, and purge behavior on both SQLite-compatible runtimes.
- A synthetic 1,000-primary/600-rival corpus completes with one embedding pass
  and no AI judge request larger than 25 candidate pairs.
- Real public-domain validation records discovered, selected, assessed,
  accepted, persisted, and presented counts. It does not claim 1,000 products
  when the public site exposes fewer.
- Typecheck, build, lint, and the full test suite pass.

## Review and release gate

- Fable 5 must review the architecture and final diff strictly.
- If Claude authentication remains expired, a fallback review may guide fixes
  but cannot be labelled Fable or satisfy the repository merge gate.
- The PR remains unmerged while that gate is unavailable or blockers remain.
- Deploy the exact approved commit to Trigger, VPS, and Sites as applicable,
  then verify a real saved report before enabling a limit above 60.

## Validation evidence

- TypeScript typecheck: passed.
- Sites build and VPS build assertion: passed.
- ESLint: zero errors; two pre-existing `img` performance warnings remain.
- Full test suite: 533/533 passed.
- Synthetic deep-catalog test: 1,000 selected primary products, one embedding
  pass, bounded 25-pair judge requests, and checkpoint replay with zero new
  judge calls.
- Real public-domain check on `myjam.co.uk` (2026-08-07): its two advertised
  product sitemaps yielded 1,001 unique public product URLs; 1,000 included a
  sitemap image. The authenticated match route truthfully retains at most
  1,000 primary products for analysis.
- Strict Fable review attempt: blocked before review because the installed
  Claude session's OAuth credential expired and could not refresh. The PR must
  remain draft and unmerged until verified Fable 5 returns PASS.
- The fallback strict review initially blocked release on retry heartbeats,
  checkpoint batch-count binding, and a soft judge-pair ceiling. All three were
  corrected and covered by tests; this fallback review does not replace Fable.
