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
`4` authentication/transport, `5` failed, `6` pending or outcome unknown, `7`
quota/entitlement, `8` inconsistent authoritative facts, and `9` a request ID
that is already bound to different work. Code `9` must be corrected by the
orchestrator; it is not retryable as transport failure.

## Cost guard

The default and smallest request is 20 comparison pairs. The server permits
only `20`, `50`, `500`, or `1000`, and the company workspace has an independent
maximum-per-report target plus a UTC-day comparison-unit ceiling. Every created
reservation counts for that day even if its run fails. A replay does not count
again. Do not generate a new request ID merely because a POST outcome was
ambiguous.

## Operator provisioning

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
