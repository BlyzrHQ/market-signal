# Market Signal company-agent CLI

`marketsignal-internal` is the private loop-to-loop interface for Market Signal
company agents. It is not the customer CLI and it does not use browser login or
a customer Stripe plan.

## Agent command

```powershell
marketsignal-internal report babanuj.com `
  --comparisons 20 `
  --request-id orchestrator:babanuj:001 `
  --output json
```

The JSON response is the existing versioned report-loop contract. It includes
the stable request and run IDs, terminal or resumable state, coverage,
competitor roll-ups, priced product comparisons, quality-evaluation state,
limitations, and provider cost when known.

Use a unique, deterministic request ID for one logical request. Repeating the
same command is safe and returns the same run. If the command exits with code 6,
resume it without submitting again:

```powershell
marketsignal-internal wait <public-report-id> `
  --request-id orchestrator:babanuj:001 `
  --output json
```

To read a snapshot without waiting:

```powershell
marketsignal-internal result <public-report-id> `
  --request-id orchestrator:babanuj:001 `
  --output json
```

Exit codes are stable: `0` complete, `2` usable but limited, `3` contract drift,
`4` authentication/transport, `5` failed, `6` pending, `7`
quota/entitlement, `8` inconsistent authoritative facts, and `9` a request ID
that is already bound to different work. Code `9` must be corrected by the
orchestrator; it is not retryable as transport failure. `10` means terminal
`outcome_unknown`: stop polling and ask an operator to inspect the run. Do not
automatically create another paid report.

## Cost guard

The default and smallest request is 20 comparison pairs. The server permits
only `20`, `50`, `500`, or `1000`. With operator-enabled unlimited mode, the
company service credential bypasses internal entitlement caps after the server
verifies its own registered production Trigger key. No Trigger key is stored on
agent machines. Other internal workspaces and customer plans are unchanged. Every created
reservation counts for that day even if its run fails. A replay does not count
again. Do not generate a new request ID merely because a POST outcome was
ambiguous.

Unlimited internal quota does not mean free provider usage. Caller budgets,
bounded research attempts, rate limits (6 creates/minute, 120 reads/minute),
idempotency and usage records remain. Unknown cost is not zero. Start with 20
comparisons when checking a new domain.

## Unlimited company access (operator setup)

This implementation uses `internal CLI -> VPS report API -> Trigger.dev`.
It is not a standalone direct-to-Trigger client. No browser login, customer
subscription or Sites deployment is required.

On the protected VPS environment, the operator must configure:

| Variable | Value |
| --- | --- |
| `MARKET_SIGNAL_INTERNAL_UNLIMITED` | `true` opts the reserved company principal in; unset/false retains existing quotas |
| `MARKET_SIGNAL_INTERNAL_TRIGGER_PROJECT_REF` | Our approved `proj_...` reference |
| `MARKET_SIGNAL_INTERNAL_TRIGGER_PROJECT_ID` | Its expected internal project ID from Trigger |
| `MARKET_SIGNAL_INTERNAL_TRIGGER_KEY_SHA256` | Lowercase SHA-256 fingerprint of server-owned `TRIGGER_SECRET_KEY`; comma-separated fingerprints support rotation (maximum 32) |

The existing company service principal must already be provisioned, an owner
of the internal company workspace, and have its internal entitlement enabled.
When unlimited mode is enabled, missing configuration denies new company report
submissions. The production `TRIGGER_SECRET_KEY` stays in the existing server
secret store and is used for verification and dispatch. Never put its raw value
in the fingerprint variable, an agent host or a commit. Possession of a Trigger
key alone does not authenticate a caller to our API.

Rotate production keys previously exposed in chat and verify the old key is
revoked before enabling this mode. Do not print either key or the bootstrap
response (it echoes the key). Agent machines keep their existing scoped internal
credential; first-time provisioning is below. No new CLI login is needed.

Before report submission, after company authentication and the create rate limit,
the server verifies its key at the fixed Trigger HTTPS project/prod endpoint and
checks project ID and API origin. It does not cache verification or follow
redirects. Removing a fingerprint or revoking the key blocks new submissions.
Polling and reads do not depend on this remote verification, so they remain
available during a Trigger outage. No API call provisions a principal or enables
this mode.

To stop quota-free submissions, unset `MARKET_SIGNAL_INTERNAL_UNLIMITED`; revoke
the internal credential or disable its entitlement to block company creation
altogether. Restart the app after changing environment settings. This does not
cancel already-dispatched work. Use `report`, `wait` and `result` as above.

## Company agent credential provisioning

Provisioning is deliberately separate from agent use. On the server, run the
private script against the mounted SQLite database and write the one-time key to
a temporary mode-0600 file. Defaults are a 20-pair report maximum, 20 units per
UTC day, and 90-day expiry:

```sh
node scripts/provision-internal-agent-cli.mjs \
  --database /data/market-signal.sqlite \
  --secret-file /tmp/market-signal-internal.key
```

The app container's `/tmp` is the only permitted extraction location. Never use
`/data`, never print or `cat` the file, and remove both copies immediately after
import. From the VPS deployment directory, copy it out with Docker's file-copy
channel (the source file is mode `0600`):

```sh
container_id="$(docker compose ps -q app)"
docker cp "${container_id}:/tmp/market-signal-internal.key" ./market-signal-internal.key
docker compose exec -T app node -e "require('node:fs').unlinkSync('/tmp/market-signal-internal.key')"
```

Transfer the host copy over an approved encrypted operator channel without
printing it. On each company agent host, import it once into the isolated
operating-system credential store:

```powershell
Get-Content -Raw .\market-signal-internal.key |
  marketsignal-internal configure --stdin
Remove-Item -LiteralPath .\market-signal-internal.key
```

For rotation, stage the operator and agent-host steps first, then rerun
provisioning with `--rotate`, import the new file, and delete the transfer file.
Rotation deliberately revokes the prior key immediately, so agent calls pause
until the new key is imported; losing the transfer file requires another
explicit rotation. The script prints only key metadata. There is no HTTP
endpoint that grants this entitlement, and no plaintext key is stored in the
database.
