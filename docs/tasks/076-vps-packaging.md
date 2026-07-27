# Task 076 — VPS production packaging

## Goal

Package the merged Node and SQLite runtime as a reproducible, least-privilege
VPS deployment while leaving Sites, Trigger production, DNS, and customer data
unchanged.

## Architecture

Docker Compose runs two services:

- `app`: the vinext Node server, all crawl/match/enrich/action endpoints, and a
  SQLite database at `/data/market-signal.sqlite`.
- `caddy`: public ports 80/443, automatic TLS for the configured domain,
  security headers, compression, JSON access logs, and reverse proxying to the
  private app service.

Trigger.dev remains external. It will later call the Caddy HTTPS origin with
the same versioned worker API and callback credential.

## Scope

- Multi-stage production Docker image pinned to Node 22.
- Production-only runtime dependencies and a non-root application user.
- Docker Compose service health, restart, read-only filesystem, persistent
  SQLite and backup mounts, and Caddy state.
- Caddy HTTPS proxy configuration suitable for the report operation budgets.
- A secret-free VPS environment template.
- Online SQLite backup and integrity-verification commands.
- A provisioning, deploy, rollback, backup, and restore runbook.
- Static validation for the Docker, Compose, Caddy, environment, and backup
  contracts.

## Data and security boundaries

- `/var/lib/market-signal` is the only live SQLite data directory.
- `/var/backups/market-signal` stores local backups; a later provisioning task
  must copy them offsite.
- Secrets are loaded from `deploy/vps/market-signal.env`, which is ignored.
- The Node port is exposed only to the private Compose network.
- The application container runs as UID/GID `10001`, drops Linux
  capabilities, uses `no-new-privileges`, and has a read-only root filesystem.
- No API key, callback token, database, certificate, or VPS credential is
  committed.

## Acceptance criteria

1. The Docker image builds the asserted VPS artifact and contains production
   dependencies required by `vinext start` and `better-sqlite3`.
2. The application runs as a non-root user and writes only to its data, backup,
   and temporary mounts.
3. Compose publishes only Caddy ports 80/443 and keeps the app private.
4. Caddy obtains TLS for `MARKET_SIGNAL_DOMAIN`, emits JSON logs, and does not
   impose a timeout shorter than Trigger's 300-second crawl budget.
5. Health checks fail when the app is unavailable and gate Caddy startup.
6. A live SQLite backup can be created, passes `PRAGMA quick_check`, and uses a
   timestamped collision-resistant filename.
7. The runbook includes provisioning, deploy, rollback, backup, restore,
   firewall, DNS, and Trigger cutover boundaries.
8. Existing tests, both build targets, lint, Go tests, static deployment tests,
   and `git diff --check` pass.
9. Strict Fable 5 review returns PASS before publication or merge.
10. No production deployment occurs in this task.

## Architecture review

Verified Fable 5 recommended a single VPS with Caddy, Node, local SQLite WAL,
system supervision/container restart, offsite backups, and Trigger retained as
the durable coordinator. It identified proxy timeout configuration, native
SQLite packaging, filesystem permissions, backup integrity, and rollback as
the important packaging risks addressed here.

## Strict review record

Verified `claude-fable-5` initially blocked the implementation because Caddy
inherited application secrets and the restore procedure did not remove stale
WAL/SHM sidecars. The remediation isolates Caddy to the domain variable,
requires WAL/SHM removal during a stopped restore, publishes backups only
after integrity verification, bounds container logs, labels images with their
source revision, and forbids rebuilding an old rollback tag from another
checkout. A focused re-review is required before publication.

The focused re-review returned `PASS` with no blocker or high-severity
findings. Its two operational advisories were also applied: a pre-restore
rollback copy now preserves the database and its sidecars as one set, and the
runbook invokes backup scripts directly without an npm wrapper.
