# Task 077 - Provision the Market Signal VPS

## Goal

Provision the dedicated Ubuntu VPS for `signal.blyzr.com`, deploy the exact
approved Market Signal commit, connect the existing Trigger.dev coordinator,
and validate a real persisted report before any Sites retirement.

## Production target

- Host: `191.218.162.18`
- Domain: `signal.blyzr.com`
- Operating system: Ubuntu 24.04 LTS
- Runtime: Docker Engine and Docker Compose from Docker's official apt
  repository
- Public edge: Caddy on TCP 80/443 and UDP 443
- Private application: vinext Node service on the Compose network
- Data: SQLite at `/var/lib/market-signal/market-signal.sqlite`
- Local backups: `/var/backups/market-signal`
- Coordinator: existing Trigger.dev project

## Scope

- Add an idempotent Ubuntu bootstrap script for Docker, firewall rules,
  unattended security updates, and persistent directories.
- Add a read-only preflight script that fails closed on wrong DNS, missing
  Docker, unsafe permissions, unavailable resources, or unexpected listeners.
- Make the inherited Compose packaging assertion portable across LF and CRLF
  checkouts so a fresh Windows validation is meaningful.
- Pin deployment shell scripts to LF, require an exact single A record with no
  AAAA record, and refuse bootstrap re-runs after containers exist.
- Validate scripts statically and against a disposable/local environment where
  possible.
- Strict Fable 5 review and merge before running the bootstrap on production.
- Deploy the exact merged commit and record its OCI revision label.
- Configure fresh runtime secrets outside Git and configure Trigger.dev to call
  the final HTTPS origin.
- Validate TLS, private API authorization, SQLite persistence across restart,
  online backup integrity, and at least one real public-domain report.

## Safety boundaries

- Never commit or print API keys, Trigger credentials, callback tokens, SSH
  private keys, database files, or certificate material.
- Keep SSH access open before enabling UFW.
- Publish only Caddy's 80/443 ports; Docker-published ports can bypass UFW.
- Do not retire or redirect the Sites deployment during this task.
- Do not call the VPS ready if AI or Trigger credentials are placeholders.
- Preserve any existing database and sidecars before a restore or destructive
  migration.

## Acceptance criteria

1. Bootstrap is idempotent on Ubuntu 24.04 and installs Docker from the official
   apt repository rather than the convenience script.
2. UFW allows SSH, HTTP, HTTPS, and HTTP/3 only, with default-deny inbound.
3. Persistent directories exist with owner `10001:10001` and mode `0750`.
4. Preflight confirms domain/IP, Docker/Compose, firewall, disk, memory,
   directory permissions, and port state.
5. Existing tests, both builds, lint, Go tests, deployment tests, and
   `git diff --check` pass.
6. Verified Fable 5 returns strict PASS and merges the PR.
7. The production image label equals the exact merged commit.
8. Caddy serves a valid certificate for `signal.blyzr.com`.
9. Trigger.dev can authenticate to the private worker API and complete a real
   report.
10. The report survives an application restart and an integrity-checked backup
    is produced.
11. Sites remains available as rollback until a separate retirement decision.

## Known external requirements

Fresh production values are required for `OPENAI_API_KEY`,
`TRIGGER_SECRET_KEY`, and `MARKET_SIGNAL_CALLBACK_TOKEN`. Credentials pasted
into chat are not eligible for production use and must be rotated.

## Strict review record

Verified `claude-fable-5` initially blocked DNS validation that allowed extra
A/AAAA destinations and Windows checkouts that could convert deployment
scripts to CRLF. The remediation requires one exact A record, no AAAA record,
pins executable scripts to LF, strengthens firewall/listener validation,
configures unattended security updates, and refuses bootstrap after containers
exist. Focused re-review returned `PASS` with no blocker or high-severity
finding.
