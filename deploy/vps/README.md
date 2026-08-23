# Market Signal VPS deployment

This package runs the public web application and a CPU- and memory-bounded report worker as
separate containers on one VPS. Caddy sends only the exact protected crawl,
matching, enrichment, brief, and action paths to the worker. Trigger.dev
remains the durable job coordinator and calls the protected VPS API. The VPS
owns the shared SQLite/WAL database and backup files.
The app process also rejects those processing routes by role, so a Caddy route
regression fails closed instead of executing heavy work on the web process.

## 1. Provision the host

Use Ubuntu 24.04 with Docker Engine and the Compose plugin. Add an SSH key,
disable password login after confirming key access, and allow inbound traffic
only on SSH, HTTP, and HTTPS. Keep Docker's application port private.

Create storage owned by the unprivileged container user:

```sh
sudo install -d -o 10001 -g 10001 -m 0750 /var/lib/market-signal
sudo install -d -o 10001 -g 10001 -m 0750 /var/backups/market-signal
```

## 2. Configure secrets and DNS

Copy `deploy/vps/market-signal.env.example` to
`deploy/vps/market-signal.env`, fill every required value, and run:

```sh
chmod 600 deploy/vps/market-signal.env
export MARKET_SIGNAL_ENV_FILE=./deploy/vps/market-signal.env
```

Never commit that file. Point the chosen domain's A/AAAA records at the VPS.
Caddy obtains and renews TLS automatically once DNS and ports 80/443 work.

Set `MARKET_SIGNAL_APP_ORIGIN` in the Trigger.dev environment to the final
HTTPS domain. Trigger.dev calls `/api/internal/*` using
`MARKET_SIGNAL_CALLBACK_TOKEN`; the browser never receives this secret.

## 3. Build and start an exact revision

Check out the approved Git commit, then tag the image with that commit:

```sh
export MARKET_SIGNAL_REVISION="$(git rev-parse HEAD)"
export MARKET_SIGNAL_IMAGE_TAG="$(git rev-parse --short=12 HEAD)"
docker compose --env-file "$MARKET_SIGNAL_ENV_FILE" config --quiet
docker compose --env-file "$MARKET_SIGNAL_ENV_FILE" build --pull app
docker compose --env-file "$MARKET_SIGNAL_ENV_FILE" up -d
docker compose --env-file "$MARKET_SIGNAL_ENV_FILE" ps
```

Verify both `app` and `worker` are healthy, then verify
`https://$MARKET_SIGNAL_DOMAIN/` and the internal capability endpoint from an
authenticated operational client. Do not move Trigger traffic until a
real-domain report succeeds, the public site remains responsive during report
processing, and the report persists after both containers restart.

## 4. Backup and verify

SQLite's online backup API takes a consistent snapshot while WAL mode is in
use:

```sh
docker compose --env-file "$MARKET_SIGNAL_ENV_FILE" exec -T app \
  node scripts/backup-sqlite.mjs
docker compose --env-file "$MARKET_SIGNAL_ENV_FILE" exec -T app \
  node scripts/verify-sqlite-backup.mjs \
  /backups/market-signal-YYYYMMDDTHHMMSSmmmZ-xxxxxxxx.sqlite
```

Copy verified backups off the VPS with an encrypted tool such as restic or an
equivalent provider. A backup that exists only on this VPS is not disaster
recovery. Monitor backup age, integrity-check failures, disk usage, container
health, and HTTP 5xx rates.

## 5. Restore

Restoration is an explicit maintenance operation:

1. Stop the app with
   `docker compose --env-file "$MARKET_SIGNAL_ENV_FILE" stop app`.
2. Preserve the current database together with any matching `-wal` and `-shm`
   sidecars as one rollback set.
3. Verify the selected backup with `verify-backup:vps`.
4. Delete the stopped database's stale `market-signal.sqlite-wal` and
   `market-signal.sqlite-shm` sidecars.
5. Copy the verified backup to
   `/var/lib/market-signal/market-signal.sqlite`.
6. Set ownership to `10001:10001` and mode to `0640`.
7. Start the app, check health, and read a known report.

Never overwrite the live database while the app is running.

## 6. Rollback and cutover

To roll back application code, verify that the last approved image exists
locally or in the registry, set `MARKET_SIGNAL_IMAGE_TAG` to that immutable
tag, and run:

```sh
docker compose --env-file "$MARKET_SIGNAL_ENV_FILE" up -d --no-build
```

Never rebuild an old tag from a different checkout. Database schema changes
require a compatibility check before code rollback; restore a verified
pre-release backup only when the migration is not backward compatible.

The VPS is the only supported web runtime. Verify TLS, capability, Trigger
callback, a real crawl, persistence, restart, and backup/restore behavior before
promoting a release. DNS and Trigger production-origin changes remain separate
release tasks.

## 7. GitHub Actions handoff

After the one-time dedicated deploy account is installed, production releases
can be dispatched from GitHub without sharing secrets in chat. Follow
`docs/GITHUB_VPS_HANDOFF.md`. The workflow builds an exact approved `master`
revision on a GitHub-hosted runner, publishes it to private GHCR by digest,
takes a verified SQLite backup, and deploys without rebuilding on the VPS.

The workflow updates only `OPENAI_API_KEY`. Trigger credentials remain in the
VPS runtime file. GitHub Environment approval, pinned SSH host identity,
immutable image verification, TLS, and container health all fail closed.
