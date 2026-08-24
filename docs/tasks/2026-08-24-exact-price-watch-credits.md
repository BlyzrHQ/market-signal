# Exact rival price watch with plan credits

## Outcome

Add an opt-in price watcher for exact rival product pages already present in an owned Market Signal report. Customers can watch one eligible comparison or take a fixed snapshot of every eligible item for a rival, choose hourly or daily checks, see price history and shared in-app alerts, and receive batched email alerts. Monitoring is deterministic and never invokes AI or product search.

This task also closes the hosted-report authorization gap: workspace-owned reports and their match pages become private, while legacy unowned reports remain read-only until their existing retention expiry.

## Approved product rules

- A watcher targets one exact saved rival product URL and one normalized variant/quantity identity.
- The source must already have a positive price, supported currency, exact public URL, and owned report match.
- `Watch all` snapshots the currently eligible items for one rival. Later reports do not add targets automatically.
- Identical canonical URL-and-variant targets in one workspace reuse one watcher and consume one credit per scheduled check. Canonical URL identity lowercases the host and scheme, removes credentials, fragments, and default ports, normalizes an empty path to `/`, preserves path case, preserves and sorts every non-marketing query key/value (including variant, SKU, option, pack, currency, and country selectors), and strips only `utm_*`, `gclid`, `fbclid`, `msclkid`, `mc_cid`, and `mc_eid`. HTTP and HTTPS remain distinct. A paid baseline records a permitted same-domain final URL separately; later checks must resolve to that same URL without rewriting the saved target identity.
- Variant identity is server-derived from persisted match facts, never client text: a stable canonical tuple of the rival product's canonical quantity plus the persisted assessment's normalized variant and normalized size. Empty facts use a `default` sentinel. The original identity facts and canonicalization version are stored so migrations and deduplication are testable.
- One credit means one scheduled check of one exact target. The initial baseline check costs one credit.
- A bounded retry and the immediate confirmation fetch for a detected change are included in that credit.
- Market Signal failures before an external source attempt release the reserved credit. An attempted rival-source check consumes it even when blocked, missing, or invalid.
- Included monitoring credits reset with the Stripe billing period and do not roll over: Starter 1,000; Solo 5,000; Growth 25,000; Agency 100,000.
- There are no watcher-count caps, overages, or top-ups in v1. Credits are the sole commercial limit.
- Every workspace member can manage watchers and spend the shared workspace balance. Mutations are audited.
- When credits are scarce, oldest-due work runs first. Credit-paused watchers resume automatically in the next billing period.
- An inactive subscription pauses watchers. Reactivating billing requires a manual watcher resume. Downgrades preserve watchers. The allocation changes only when Stripe reports the new price as effective: an immediate change replaces the allocation for the same period without clawing back committed usage, while a scheduled change waits for the next period. Remaining credit is clamped to zero when preserved usage plus in-flight reservations exceeds the lower allocation; no new checks are reserved until the next period, when credit-paused watchers auto-resume.
- Daily means approximately every 24 hours; hourly means approximately every 60 minutes. Checks are staggered and not tied to a customer timezone.
- Three consecutive rival-source validation failures pause a watcher and notify the workspace. Failure-paused and subscription-paused watchers require manual resume.
- Turning a watcher off keeps its history and consumes no credits. Turning it on performs a fresh paid baseline and does not alert from stale history.
- A report expiring automatically does not delete its watchers. Manual report deletion must ask whether to delete linked watchers.
- Price-only monitoring is in scope. Stock state is not. A missing or hidden price is a failed check.
- Currency/storefront changes and cross-country redirects are rejected; no FX conversion is performed.
- Only current payable price is compared. Explicit regular/list price is stored as context when observed, so sale start/change/end can be reported without treating list price as the payable price.
- A numeric payable-price or explicit list-price-context change must be confirmed by one immediate second deterministic fetch before alerting. Formatting-only changes are ignored. If confirmation matches the candidate tuple, the change is confirmed; if it returns the existing baseline tuple, the check succeeds unchanged; if it fails validation or returns a third tuple, the check is `confirmation_inconclusive`, consumes the already-started credit, leaves the baseline unchanged, emits no alert, and increments the same consecutive-failure streak. No third fetch is made.
- Confirmed changes update the baseline. The same unchanged price never generates repeated alerts.
- In-app alerts are immediate and workspace-shared. Email is sent to the watcher creator in 15-minute batches; if the creator leaves, ownership transfers to the current workspace owner. Better Auth ownership transfer must complete before an owner leaves. If no eligible owner exists, email is suspended while shared in-app alerts continue.
- Watcher history remains for the workspace lifetime. Re-enabling remains allowed after every linked report expires or is deleted because the watcher owns its validated target snapshot. A permanent watcher deletion purges its links, reservations, observations, events, notifications/read rows, pending email, and source URL/email data. Its audit entry retains only action, actor id, timestamp, and a random non-reversible deletion tombstone. Permanent workspace deletion cascades through every watcher table, including audit logs and email outbox; append-only audit immutability applies only while the workspace exists.
- Monitoring never invokes AI or web search. Parser failure is surfaced and contributes to the three-failure pause.

## Security and data boundaries

- Hosted report reads, match pagination, exports, watcher controls, history, and alerts require an authenticated member of the owning workspace.
- Unauthorized access to a workspace-owned report returns `404` and no ownership metadata. Responses use `Cache-Control: private, no-store` and `Vary: Cookie`.
- Legacy rows with an empty `workspace_id` remain read-only public until the existing report expiry. They cannot create watchers or consume credits.
- New hosted runs are already created with a workspace id; self-hosted billing-disabled runs retain their existing local behavior.
- Watcher activation accepts a report id and persisted match id, never an arbitrary client-supplied URL or price.
- Public fetch safety, robots policy, same-domain redirects, size limits, timeouts, and market/currency validation remain mandatory.
- Stripe continues to be the subscription source of truth. Monitoring usage is an internal plan entitlement, not Stripe metered billing or an overage charge.
- Stripe webhooks remain signature verified and idempotent. No secrets are added to source, logs, report payloads, or analytics.
- Billing-period entitlement rows are unique by workspace and Stripe period identity. Duplicate subscription/invoice webhooks reconcile the same row and cannot reset or add credits twice.
- The internal callback token is compared in constant time, may be rotated with an overlap window, and is provisioned to Trigger.dev and the VPS before either price-watch artifact is deployed.

## Persistence design

Add SQLite/Drizzle schema and runtime bootstrap statements for:

- `price_watchers`: workspace, canonical target, validated resolved URL, variant identity, creator/email owner, cadence, state, baseline, failure streak, next/last check, and timestamps;
- `price_watcher_report_links`: many-to-many links to source reports and persisted match ids;
- `price_watch_credit_reservations`: period-bound idempotent `reserved`/`attempting`/`committed`/`released` records for scheduled checks, with claim owner and lease expiry;
- `price_watch_observations`: baseline and confirmed price/sale changes only; unchanged values are not duplicated;
- `price_watch_events`: failures, recoveries, pauses, resumes, and ownership changes;
- `workspace_notifications` and `workspace_notification_reads`: shared notifications with per-member read state;
- `price_watch_email_outbox`: change alerts grouped into 15-minute delivery batches;
- `price_watch_audit_log`: immutable actor/action records for customer mutations.

All credit claims and watcher state transitions use immediate SQLite transactions and unique idempotency keys. The check key is unique for the watcher and scheduled due slot. A claim creates a `reserved` row and a ten-minute watcher lease. Immediately before the first network dispatch, one transaction moves the reservation to `attempting`; that durable dispatch boundary is the charge boundary. A completed external attempt moves it to `committed`. Only a Market Signal failure while still `reserved` moves it to `released`.

Every scheduler pass first reaps expired leases. Expired `reserved` rows are released and made due again. Expired `attempting` rows are conservatively committed once, recorded as an unknown-outcome failure, and scheduled for the next normal cadence without another immediate external request. Expired terminal rows only clear stale leases. Re-execution uses the same check key, so a crash cannot create a second reservation or debit. This deliberately charges the narrow crash window after durable dispatch intent but before the socket attempt because releasing it could undercount a rival-source request that already left the process.

## Runtime flow

1. An authenticated member activates one match or a rival snapshot. The server resolves eligible persisted facts, canonicalizes and deduplicates targets, then uses one immediate SQLite transaction to reconcile the active period, compute remaining credit, verify every baseline fits, and insert every watcher/link/baseline reservation all-or-nothing. Concurrent members cannot both pass affordability and oversubscribe the period.
2. A Trigger.dev schedule runs every five minutes and calls a callback-token-protected internal endpoint. The production scheduler is capped at eight claims per pass, eight concurrent targets globally, and two concurrent targets per registrable domain. The lower production batch bound keeps a same-domain batch within Trigger's five-minute task ceiling even when a check needs its included retry or confirmation; the storage claim primitive remains hard-capped at 50 for bounded recovery tooling. A transient transport, `429`, or `5xx` result receives at most one retry in the same credit; the separate change-confirmation fetch is not a retry.
3. The endpoint reconciles subscription/period state, reaps leases, claims oldest-due watchers, and processes the bounded batch.
4. Each target is fetched and parsed with the existing deterministic public-product enrichment boundary. No discovery provider, model, or AI action code is reachable.
5. A first observation establishes a baseline. A potential change receives one immediate confirmation fetch inside the same credit. Only matching confirmed values become observations and alerts.
6. The check updates `next_check_at`, failure state, credit reservation, observation/event rows, notification rows, and pending email rows atomically where practical and idempotently otherwise.
7. The same scheduled task flushes email batches that are at least 15 minutes old. Email delivery is provider-isolated and retry-safe; missing email configuration leaves the outbox pending and never affects in-app alerts or price checks.
8. The first transition to zero available credit creates one deduplicated workspace notification and pauses due work. The account surface also projects exhaustion from active cadence.

## Customer surfaces

- Add per-row watcher controls to the product comparison table: off/on state, daily/hourly cadence, status, and projected credit use.
- Add a rival-level `Watch all` action with eligible item count, projected daily/monthly use, estimated exhaustion date, and a confirmation step.
- Add `/price-watch` as the central authenticated workspace page showing shared balance, active/paused watchers, cadence, last/current price, next check, history, failure state, and controls.
- Add a notification bell/unread count and persisted shared notification list.
- Show monitoring-credit allocation and usage on the account/billing page.
- Remove public-cache and public-share wording from owned report paths. Links remain useful to authenticated workspace members.

## Non-goals

- Fresh product discovery, search, competitor discovery, AI fallback, and FX conversion.
- Stock monitoring or browser/OS push notifications.
- Exact customer-selected run times, quiet hours, per-watcher email preferences, credit top-ups, overages, rollover, or member quotas.
- Auto-watching products from future reports.
- Mutating historical report facts when a watched price changes.

## Validation

- Unit tests cover eligibility, URL/variant canonicalization and versioning, variant deduplication, entitlement amounts, projected usage, reserve/attempt/commit/release idempotency, lease reaping at every crash boundary, billing-period reset and duplicate webhook reconciliation, immediate and scheduled downgrade behavior, oldest-due ordering, pause/resume transitions, three-failure handling, currency/redirect rejection, every confirmation outcome, discount transitions, notification deduplication, report ownership, deletion cascades, and legacy read-only behavior.
- Route tests cover unauthenticated/non-member `404`, exact private cache headers, same-origin mutation enforcement, bounded request bodies, activation from server-resolved facts, concurrent bulk all-or-nothing baseline affordability, all-member mutations, and notification read state.
- Trigger/core tests prove the production batch bound of 8, storage claim hard-cap of 50, global concurrency 8, per-domain concurrency 2, one transient retry, no-AI dependency reachability, lease recovery, and email grouping.
- Full typecheck, build, lint, and test suite pass.
- A real public product URL is checked with the deterministic watcher in a non-billing test harness. It must establish a positive supported-currency baseline without any model/provider call.
- Production validation uses one low-cost exact target and does not launch a report evaluation or high-volume watcher batch.

### Pre-review evidence — 2026-08-24

- `npm test` passed both TypeScript checks, the production build, and all 1,148 repository tests with zero failures.
- The focused price-watch suites passed 31 tests covering storage, migrations, routes, email batching, and Trigger transport behavior.
- `npm run lint` passed with zero errors; it retained one pre-existing `next/image` advisory in the product design lab.
- `git diff --check` passed (Git only reported the repository's existing Windows line-ending notices).
- One bounded deterministic live check fetched only `https://scrapeme.live/shop/Bulbasaur/` plus its robots policy. It pinned the same product URL and established a positive GBP 63.00 baseline without AI, search, report creation, or a billing debit.
- A negative control against a minimal page without sufficient structured product identity failed closed as `identity_mismatch`; no ambiguous visible price was accepted.

## Delivery

- Branch: `codex/price-watch-credits`
- Draft PR remains unmerged until strict verified Fable 5 review has no blockers, Codex independently verifies all checks and the exact deployment, and Fable marks ready and merges.
- Provision the rotatable callback token first. Deploy the Trigger task before the VPS commit, as required by repository policy. Until the VPS exposes the new capability, the task treats an absent/disabled price-watch capability as an explicit deployment no-op (structured metric, no retry storm, no watcher mutation); it does not treat arbitrary runtime errors as no-ops. Deploy the VPS schema/bootstrap, endpoint, and capability flag together, verify the endpoint is healthy, then verify authenticated report privacy, one watcher baseline, one credit debit, history, notifications, and health at the exact reviewed revision.

## Stripe Tax note

This task does not enable Stripe Tax or change plan prices. Before charging customers in additional tax jurisdictions, configure registrations and Stripe Tax separately; enabling automatic tax without registrations would not collect tax.
