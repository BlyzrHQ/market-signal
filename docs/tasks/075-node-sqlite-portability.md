# Task 075 — Node and SQLite portability

## Goal

Run the existing Market Signal application on a conventional Node VPS with a
durable local SQLite database while retaining the current Sites and D1 build
path until production cutover.

## Architecture decision

The VPS hosts the web application and all crawl, matching, enrichment, ads, and
action endpoints. Trigger.dev remains the durable coordinator: the application
dispatches a small report job, then Trigger calls the VPS worker API over HTTPS
with the existing callback credential.

The first VPS database is SQLite because the application already uses the
SQLite dialect through a small D1-shaped interface. The Node adapter must
preserve D1 batch atomicity, named result rows, and positional binding. WAL and
a bounded busy timeout protect the expected single-server concurrency.

## Scope

- Move the duplicated D1-shaped database contract into a shared application
  module.
- Add a Node SQLite implementation using a server-only driver.
- Select SQLite when `MARKET_SIGNAL_SQLITE_PATH` is configured and otherwise
  retain the existing Cloudflare D1 binding.
- Cache one database connection per canonical SQLite path.
- Preserve atomic `batch()` behavior and roll back every statement if one
  fails.
- Add an explicit `MARKET_SIGNAL_DEPLOY_TARGET=node` vinext build target that
  excludes the Cloudflare development plugin while leaving the default Sites
  build unchanged. Fail the VPS build if Cloudflare wrangler metadata appears
  in its output.
- Add VPS build and start scripts.
- Add real SQLite integration tests for report persistence, idempotency,
  competitor memory, concurrent access behavior, and transaction rollback.

## Out of scope

- VPS provisioning, Docker, reverse proxy, TLS, firewall, backups, and DNS.
- D1 data export/import.
- Trigger production-origin changes.
- Disabling or redirecting the existing Sites deployment.

Those are separate tasks after this portability seam is merged.

## Environment contract

- `MARKET_SIGNAL_SQLITE_PATH`: absolute path to the VPS database file. Its
  parent directory must already exist and be writable.
- Without that variable, the application uses the Cloudflare `DB` binding.
- Secrets remain server-side and are not stored in the database path or
  repository.

## Acceptance criteria

1. The SQLite adapter returns D1-compatible `{ results }` values and positional
   binds.
2. `batch()` commits all statements atomically and rolls back all statements on
   failure.
3. WAL mode, foreign keys, and a bounded busy timeout are configured.
4. Report runs, events, documents, and remembered competitors survive closing
   and reopening the database.
5. The default Sites build and the VPS Node build both pass.
6. Existing JavaScript tests, lint, Go tests, and `git diff --check` pass.
7. Strict Fable 5 review returns PASS before publication or merge.
8. No deployment or production environment is changed by this task.

## Architecture review

Verified Fable 5 recommended keeping Trigger as the coordinator, retaining
SQLite for the first single-VPS release, and adapting the existing
`D1DatabaseLike` seam rather than rewriting persistence for PostgreSQL. It
identified atomic batch behavior, reverse-proxy timeouts, WAL configuration,
offsite backups, and validating vinext's Node production server as the main
migration risks. This task addresses the database and build risks only.

## Implementation validation

- `npm test`: 361 tests passed, including typecheck and the unchanged default
  Sites production build.
- `npm run build:vps`: passed and its assertion confirmed no Cloudflare
  `wrangler.json` metadata was present.
- Real Node production-server smoke: homepage and authenticated capability
  endpoint responded; report creation persisted a SQLite-backed run, and the
  following report read returned it. Dispatch then failed as expected because
  production Trigger credentials were deliberately absent.
- SQLite integration: persistence across reopen, duplicate-event idempotency,
  competitor memory, transaction rollback, canonical connection caching, and
  real cross-thread lock contention passed.
- Lint passed with zero errors and two pre-existing image warnings. Go tests and
  `git diff --check` passed.
- Strict Fable 5 re-review: PASS after fixing competitor-memory degradation,
  canonical connection caching, missing contention/idempotency tests, and the
  initially ineffective vinext mode flag.

No production deployment, database, Trigger environment, or DNS state changed.
