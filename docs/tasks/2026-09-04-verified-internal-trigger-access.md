# Verified company Trigger access

The owner authorizes quota-free internal usage, conditional on company-only
access and our verified Trigger project. Customer plans are unchanged.

## Final boundary

- Keep the working transport: internal CLI -> VPS report API -> Trigger.dev.
  This change is not a standalone direct-to-Trigger client.
- Keep production Trigger secrets on the server, never agent machines. Clients
  keep the existing scoped, revocable company report credential in their OS store.
- Opt in with protected `MARKET_SIGNAL_INTERNAL_UNLIMITED=true`. Only the exact
  reserved company service user/workspace, authenticated with a report API key,
  can receive an exemption. Require live owner membership and enabled internal
  entitlement. Cookies, OAuth, other workspaces and JSON flags cannot opt in.
- After the create rate limit, verify server-owned `TRIGGER_SECRET_KEY` against
  an operator-registered SHA-256 fingerprint and Trigger's fixed HTTPS endpoint
  `GET /api/v1/projects/{approvedProjectRef}/prod`. Match expected project ID,
  API origin and echoed credential; discard bounded body without logging it.
- Reads/polling do not call Trigger for verification. New submissions fail closed
  on verification failure. Disabling the opt-in restores the configured quota.
- Only verified company submissions bypass daily and per-report entitlement
  caps; supported targets remain 20/50/500/1000. Keep all reservation/audit,
  idempotency, rate limits and bounded research attempts. Require a request ID.
- No automatic resubmission. Exit 6 is pending; terminal outcome_unknown is exit
  10 and requires operator inspection, not another paid run.
- Reject HTTP redirects in the CLI transport to prevent credential forwarding.

## Review history

Verified `claude-fable-5-1`, 2026-09-04T20:06:58Z, reviewed the first proposal and
reported BLOCKED: distributing the raw Trigger key expands agent privileges;
exposed keys require rotation; verification on every poll hurts liveness; and
unlimited retries could increase spend. Accepted credential/liveness findings:
removed the client Trigger credential implementation and verifier HTTP endpoint;
Trigger verification is server-only on submission, after rate limiting.

The owner explicitly requested no internal daily quota, so silently installing
another large quota is not the resolution. Operator opt-in/off, preserved fixed
targets, bounded attempts, stable IDs, accounting and a terminal no-resubmit
state are retained. Automatic interrupted-run recovery is not introduced here.
Any exposed Trigger key must be rotated and its old value confirmed revoked
before live enablement. Do not assume the current server key matches the exposed
one without evidence, and never use that exposed value for validation.

## Validation and release

Targeted synthetic tests: registration/project/env failures, bounded responses,
revocation, no raw Trigger client auth, owner/entitlement checks, unchanged read
access, five 20-pair reservations past the prior cap, replay accounting, different
workspace isolation and required request IDs. No paid provider calls in tests.
Full Node/Go tests, typecheck, lint, VPS build and exact-head Fable review are
required before release. Live enablement is separately blocked pending safe
fresh-key registration/rotation verification. No customer report facts changed.

Pending real five-domain batch: chubbiesshorts.com, dossier.co, oseamalibu.com,
blueland.com and nuts.com; 20 comparisons each, sequentially. None launched.

### Local validation, 2026-09-04

- `npm test`: PASS, 1346 tests; includes typecheck, Node typecheck and build.
- `go test ./...` in cli: PASS.
- `npm run build:vps`: PASS; VPS artifact assertions passed.
- `npm run lint`: no errors; existing img-element performance warning only.
- `git diff --check`: PASS.
- No production changes or live provider calls. Revised Fable review pending.

### Revised review follow-up

The second Fable review accepted the server-only authorization/quota boundary.
It read an earlier guide snapshot; the committed guide no longer has a Trigger
key import command or verifier route. Its valid compatibility finding is fixed:
exit 10 is internal-only, and the public customer CLI retains exit 6 for unknown
outcomes. Both paths have tests. Fable could not run tests/network commands in
its sandbox; Codex independently ran the validations listed above.

The endpoint authentication question was independently checked against upstream
commit `25af6517295dbf67a5c9ef4385346460c7ad0b68` on 2026-09-04:

- [Bootstrap route](https://github.com/triggerdotdev/trigger.dev/blob/25af6517295dbf67a5c9ef4385346460c7ad0b68/apps/webapp/app/routes/api.v1.projects.%24projectRef.%24env.ts): resolves authenticated project/environment and returns project ID/API origin.
- [Authentication helper](https://github.com/triggerdotdev/trigger.dev/blob/25af6517295dbf67a5c9ef4385346460c7ad0b68/apps/webapp/app/services/environmentVariableApiAccess.server.ts): bootstrap accepts valid private environment keys and echoes the authenticated caller's key, not another root key (functions at lines 22-34 and 66-92).

This source check does not substitute for a live check with a fresh safely
registered production credential. Live enablement remains blocked.
