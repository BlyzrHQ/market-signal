# Isolate report processing from the customer web process

## Problem

The recovered MyJam Starter run invoked the protected crawl endpoint on the
same single Node process that serves customer traffic. The two-core production
VPS became unavailable until the Trigger run was canceled. A report must not
make sign-in, report history, health checks, or public report pages unavailable.

## Product contract

- Plan limits count published, valid, priced comparison pairs: Starter 20,
  Solo 50, Growth 500, and Agency 1,000.
- One primary product can contribute multiple comparison pairs when multiple
  independently verified rival product pages expose eligible prices.
- Published rows are deterministically grouped by primary product; processing
  proceeds through that stable order until the pair quota is met.
- This task does not relax evidence, region, currency, identity, or price rules.

## Change

- Run protected crawl, matching, enrichment, brief, ads, and action endpoints
  in a dedicated worker container built from the exact approved image.
- Route only those exact protected paths to the worker through Caddy.
- Reject those processing paths inside the customer app process even if edge
  routing regresses.
- Cap the worker at one CPU and 3 GiB so the two-core host retains CPU and
  memory capacity for the customer-facing app.
- Require both app and worker health, revision, image, capability, and database
  probes during deployment and rollback.
- Remove orphan containers on forward deploy and rollback so rejected images
  cannot retain production credentials or database access.

## Acceptance criteria

- Compose exposes neither app nor worker directly to the host.
- Caddy routes only the enumerated processing endpoints to the worker.
- Deployment fails closed unless both containers use the exact approved image
  and revision and both pass health/capability/database checks.
- Packaging, security-boundary, build, lint, and full tests pass.
- Strict verified Fable 5 review reports no blockers.
- Production stays responsive during one fresh MyJam Starter report, and the
  report publishes exactly 20 eligible priced comparison pairs before any
  higher-plan example is launched.

## Data boundaries

The worker uses the same server-owned environment and SQLite/WAL volume as the
web process. No secret is added to source control, no customer-visible report
fact is edited, and no fixture may be presented as a live result.

## Validation and review

- Full build, type checks, and test suite: 1,097 passed, 0 failed.
- Lint: 0 errors; two pre-existing image-element warnings.
- Docker Compose configuration and deployment shell syntax validated.
- Verified Fable 5 strict review initially found rollback-orphan, fail-open
  routing, and timeout blockers. The exact corrected diff was re-reviewed;
  Fable reported no remaining release blockers and returned `STRICT PASS`.
