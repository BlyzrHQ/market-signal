# Company-internal agent CLI

## Outcome

Provide a separate `marketsignal-internal` executable for company agents. An
orchestrator can submit one domain, wait for the existing report loop, and read
the same typed competitor and priced-comparison result contract without browser
login, customer dashboards, or Stripe customer quota.

The customer `marketsignal` CLI and all customer billing behavior remain
unchanged.

## Command contract

```powershell
marketsignal-internal report babanuj.com --comparisons 20 --request-id orchestrator:babanuj:001 --output json
```

- `--comparisons` accepts only the existing pair targets: 20, 50, 500, or 1000.
- The default is 20, the smallest bounded run.
- A caller-owned request ID is the idempotency key. Reusing it with the same
  intent returns the same run; changing its domain, locale, or target fails.
- A timeout emits the latest pending payload and resumable report ID with exit
  code 6. It never submits a second report.
- JSON output contains status, run and request IDs, coverage, competitor
  roll-ups, priced comparison rows, limitations, evaluation state, and known or
  unknown provider cost.

## Authorization and budget boundary

- Reuse the hosted workspace API-key principal, scopes, revocation, audit, and
  per-minute rate limits. Do not add a deployment-wide hosted bearer or another
  HTTP route.
- Provision a dedicated workspace of kind `internal` and a short-lived
  read/create key. Store the plaintext key only in the operating-system
  credential store used by the internal executable; never print or commit it.
- A server-only `internal_report_entitlements` row is the only Stripe bypass.
  There is no web route that grants or edits it, and Stripe webhooks never
  create or mutate it.
- The entitlement declares a maximum per-report comparison target and a UTC-day
  comparison-unit ceiling. The default provisioned values are both 20.
- Reserve comparison units transactionally. Every internal reservation created
  that UTC day counts, including released and failed work. A replay does not
  reserve again. Concurrent requests cannot exceed the ceiling.
- Client-supplied comparison targets are ignored for ordinary paid workspaces;
  their Stripe-resolved plan remains authoritative.

## Provisioning

Add a private operator script that creates or rotates the service principal,
workspace key, and entitlement directly in the production SQLite database. It
writes the one-time plaintext key to a caller-selected mode-0600 file and emits
only non-secret metadata. A separate hidden internal-CLI setup command imports
that file/stdin into its isolated OS credential-store namespace.

## Validation

- Unit tests cover internal reservation, target ceilings, failed reservation
  accounting, UTC reset, replay, intent collision, and concurrent ceiling use.
- Route tests prove only an entitled internal workspace can select a target and
  paid customer plan selection remains server-owned.
- Go tests prove the internal command sends its selected target, defaults to
  machine-readable quiet output, preserves request IDs, resumes without a new
  POST, and has no browser/customer login commands.
- Provisioning tests prove no plaintext key reaches stdout/stderr or the
  database and that reruns require explicit rotation.
- Run typecheck, lint, build, Node tests, and Go tests.
- Validate against a real public domain only after the production entitlement
  and 20-unit daily guard are live. Do not run a larger paid report as part of
  acceptance.
- `npm run db:generate` was checked after the model update. It exposed the
  repository's already-documented Drizzle snapshot drift and attempted to add
  unrelated OAuth, Shopify, lease, and account DDL. That unsafe generated
  migration is not part of this task; production continues to use the
  idempotent runtime schema initializer, while `db/schema.ts` records the model.

## Review record

Verified Claude Fable 5.1 architecture review (session
`ffb5ee89-a0e3-4f25-b027-6262a608b2af`) recommended one existing data plane and
principal model: a dedicated workspace key plus a server-side internal
entitlement. It explicitly rejected a new hosted deployment bearer, new
internal routes, fake Stripe subscription rows, and mTLS as unnecessary. Its
required blockers are represented above: transactional all-attempt UTC usage,
smallest default, stable request IDs, existing rate limits, secure key storage,
and no customer path to self-grant the entitlement.

## Validation record

- `npm test`: passed (1,339 tests; 0 failed).
- `npm run lint`: passed with one pre-existing `next/image` advisory in
  `app/components/product-design-lab.tsx` and no errors.
- `npm run test:open-source`: passed without private credentials.
- `npm run build:vps`: passed, including the native SQLite packaging checks.
- `go -C cli test ./...`: passed.
- `go -C cli vet ./...`: passed.
- Windows amd64 internal CLI cross-build: passed.
