# Task 091 — Restore legacy report persistence on the VPS

## Outcome

Keep historical report links working after the Sites/D1 to VPS/SQLite cutover.
The VPS remains local-first: only a valid local miss may read a report from the
fixed legacy deployment, validate it, and persist the presentation snapshot in
SQLite before serving it.

## Scope

- Add an opt-in, time-bounded legacy report recovery path to the public report
  read route.
- Accept only 32-character lowercase hexadecimal public IDs.
- Fetch only from a fixed HTTPS origin configured by the operator.
- Bound the legacy request to ten seconds and one MiB. The ten-second ceiling
  leaves headroom for the observed four-to-six-second legacy Sites response
  while keeping the temporary dependency tightly bounded.
- Validate report identity, terminal status, schema version, dates, expiry,
  events, and document before persistence.
- Preserve the original creation and expiry timestamps.
- Never overwrite a local report; concurrent recoveries must be idempotent.
- Document the VPS environment controls and sunset.

## Out of scope

- Bulk D1 export or migration.
- Proxying every report request to Sites.
- Extending report retention.
- Product-price, ads, or report-layout changes.

## Acceptance criteria

1. Local reports never issue a legacy request.
2. A known unexpired legacy report is stored in SQLite and returned; the second
   read succeeds locally when the legacy origin is unavailable.
3. Invalid IDs, mismatched IDs, expired reports, oversized responses, invalid
   schemas, and non-terminal payloads are not persisted.
4. The fallback is off unless its enable flag, fixed HTTPS base URL, and future
   sunset are all valid.
5. The legacy origin timing out does not affect existing local reports.
6. Full tests, typecheck, both builds, lint, strict Fable 5 review, PR, VPS
   deployment, and a live known-report 200 check pass before merge.

## Decision record

Verified Claude Fable 5 selected a lazy read-through migration with a hard
sunset. It rejected a bulk migration as unnecessary export machinery and a
permanent proxy as an avoidable long-lived dependency.

## Validation

- `npm test`: 416/416 tests passed, including real-SQLite local-wins,
  concurrent recovery, invalid payload, 404, redirect, and response-boundary
  coverage.
- `npm run build:vps`: passed; the Node/VPS artifact contains no Cloudflare
  deployment metadata.
- `npm run lint`: zero errors; two pre-existing `img` optimization warnings.
- Real public report `1d787f02518a44f899b1624e350c354a` imported from the
  legacy Sites origin into a temporary SQLite database. It preserved the
  `noororganicfood.com` limited report, three events, its document and original
  expiry; a second read succeeded locally while the supplied fetch function
  was configured to throw if called.

## Review

Verified Claude Fable 5 initially blocked on an uncapped imported retention
window and missing direct coverage of local-wins/concurrent recovery. Both were
fixed and re-reviewed. The complete re-review and the subsequent real-data
timeout adjustment review both returned strict PASS with no P0, P1 or blocking
P2 findings.
