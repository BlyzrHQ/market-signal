# Hosted MCP write tools

## Goal

Extend the authenticated hosted Market Signal MCP with account status, paid report creation, and price-watch controls while preserving workspace isolation, billing limits, retry safety, and explicit confirmation for costly or destructive actions.

## Scope

- Add an `account_status` tool whose fields are limited by the token's granted report and price-watch scopes.
- Add report-create preview and confirm tools. Preview is read-only and does not reserve quota; confirm consumes a short-lived, single-purpose confirmation token.
- Add price-watch activation, update, disable, and delete tools. Cost-changing and destructive operations use preview/confirm; disabling is directly idempotent.
- Persist confirmation intents, bounded per-client and per-workspace rate limits, immutable audit records, and terminal outcomes in the hosted SQLite database.
- Bind confirmations to the authenticated workspace, user, OAuth client, tool, canonical input, and calculated impact. Store only a SHA-256 token hash.
- Confirm tools accept only the token. Re-presenting the same token from the same bound identity returns the in-progress or recorded terminal outcome; cross-identity and expired unclaimed uses fail closed. A command claimed during the token's validity remains recoverable through its durable lease after token expiry.
- Never duplicate a report, watcher mutation, quota reservation, or dispatch. Report reservations and report rows carry the durable command ID and Trigger dispatch reuses the report dispatch key. Price-watch mutations record a command receipt in the same SQLite transaction as their effect.

## Security and data boundaries

- MCP bearer scopes remain the authority boundary; browser cookies are not accepted.
- All identifiers are resolved inside the authenticated workspace.
- Confirmation tokens are random 256-bit values, shown once, expire after five minutes, and are never logged or stored in plaintext.
- Reports stay private to their owner unless separately shared through the existing share flow.
- Tool output must not expose workspace IDs, user IDs, billing reservation IDs, OAuth tokens, or server credentials.
- No paid live report or price-check execution is part of automated validation.
- Impact fingerprints protect the confirmation contract, but execution still performs the authoritative transactional quota and credit checks.
- `account_status` appears when any supported resource scope is granted and returns only the report and/or price-watch fields covered by that token's scope family.
- Completed and expired confirmation intents and command receipts are pruned after 30 days; stale rate-limit windows are pruned after one day; immutable audit records remain.
- Customer-safe errors include `confirmation-expired`, `invalid-confirmation`, `impact-changed`, `report-limit-reached`, `subscription-required`, `insufficient-credits`, and `temporarily-unavailable`.
- Delete preview states that the watcher, its saved observation history, report links, pending delivery rows, and watcher-linked notifications will be removed while consumed credit debits remain charged.

## Validation

- Focused unit tests for confirmation lifecycle, expiry, cross-tenant/client rejection, replay, rate limiting, and immutable audit behavior.
- Protocol tests for scope-filtered tool discovery and safe output.
- Service tests for report preview/confirm and price-watch preview/confirm/update/disable/delete, including same-token concurrent retries and insufficient quota/credits. Every report dispatch and price check is stubbed.
- Typecheck, lint, VPS build, full test suite, strict verified Fable 5 review, exact-SHA deployment, and production metadata/authorization smoke tests.

## Known limitations

- Unclaimed confirmation intents expire after five minutes; callers must preview again after an unclaimed expiry or a material impact change. Commands claimed before expiry remain retry-safe until their durable outcome is recorded.
- In-progress commands expose a safe retry response while reconciliation completes rather than starting duplicate work.
- This change does not add MCP report sharing or notification mutation tools.

## Review notes

- The initial verified Fable 5 review found one blocker in report-command lease recovery: a retry could count its own durable reservation as changed usage. The fix probes the command reservation, excludes the command's own reservation from impact comparison, returns the durable terminal outcome to losing racers, and adds a lost-response regression test.
- The first re-review found the same recovery class in the token-expiry path: expiry could force-fail an already claimed command. The fix limits expiry failure to unclaimed intents, permits stale in-progress leases to be reclaimed after token expiry, makes report impact evaluation lazy after command-start detection, and covers post-expiry report and price-watch recovery.
- The same review's non-blocking findings were addressed by pruning stale rate and receipt rows, aligning the in-progress retry interval with the confirm rate limit, and reusing the authoritative price-watch usage helper for `account_status`.
