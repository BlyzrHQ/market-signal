# Market Signal company-agent CLI

`marketsignal-internal` is the private loop-to-loop interface for Market Signal
company agents. It is not the customer CLI and it does not use browser login or
a customer Stripe plan.

## 1. Install the company executable

On Windows, install Git and Go 1.22 or newer and obtain access to this private
GitHub repository. No Node.js, local website, or local Trigger worker is needed
on the agent machine when using the company service.

```powershell
git clone --branch codex/internal-cli-handoff --single-branch https://github.com/BlyzrHQ/market-signal.git
Set-Location market-signal
go -C cli build -o ../marketsignal-internal.exe ./cmd/marketsignal-internal
.\marketsignal-internal.exe version
.\marketsignal-internal.exe report --help
```

The executable is created in the repository root. The version is a development
build identifier unless built with release metadata. Alternatively, your
operator can supply the company executable. The website's public installer
installs the **customer** CLI, not this executable.

Commands below assume the executable is on PATH. If it is not, replace
`marketsignal-internal` with `.\marketsignal-internal.exe` while in that folder.

## 2. Configure once

```powershell
marketsignal-internal configure
```

Paste the scoped company credential from your operator into the hidden prompt.
It is saved in the operating-system credential store. Do not paste a raw Trigger
API key here. There is no browser login. If you do not yet have the credential,
the operator must provision it using the section below; building the CLI does
not grant access by itself.

Current transport is CLI → authenticated VPS report service → Trigger.dev
workers. The report service owns the Trigger connection; this executable is
not a direct Trigger API client. This documentation branch does not change that
architecture or enable the separately proposed unlimited internal usage mode.

## 3. Request a report

Replace `<domain>` with your actual store domain. This is a placeholder,
not a successful live test, and submitting a real report can incur provider
costs. Start with the smallest supported target. Replace `<request-id>` with
your unique identifier too. All angle-bracket values are required inputs, not
defaults. Omitting the domain or leaving the placeholder unchanged fails before
any report request is sent.

```powershell
marketsignal-internal report "<domain>" `
  --comparisons 20 `
  --request-id "<request-id>" `
  --output json
```

The JSON response is the existing versioned report-loop contract. It includes
the stable request and run IDs, terminal or resumable state, coverage,
competitor roll-ups, priced product comparisons, quality-evaluation state,
limitations, and provider cost when known.

Use a unique, deterministic request ID for one logical request. Repeating the
same command is safe and returns the same run. A target is not guaranteed
coverage: inspect the delivered count and limitations in the response.

## 4. Resume or retrieve the same report

If the command exits with code 6 and returns a `publicReportId`, replace
`<public-report-id>` below with that value and keep the original request ID:

```powershell
marketsignal-internal wait "<public-report-id>" `
  --request-id "<request-id>" `
  --output json
```

To read a snapshot without waiting:

```powershell
marketsignal-internal result "<public-report-id>" `
  --request-id "<request-id>" `
  --output json
```

If the outcome is unknown and no report ID was returned, retry the original
`report` command with the exact same domain, target, and request ID. Never create
a new ID just to retry an ambiguous request.

## 5. Read the output

The response is JSON for the calling agent, not just a website link. Key fields
in a terminal result are:

| Field | Meaning |
| --- | --- |
| `state` | Whether the response is pending or terminal |
| `requestId`, `publicReportId` | Correlation and resume identifiers |
| `output.status` | Report outcome; do not assume terminal means complete |
| `output.metrics.comparisonTarget` | Requested comparison pairs |
| `output.metrics.pricedComparisons` | Delivered pairs with prices |
| `comparisons.items` | Product comparison records |
| `competitors.items` | Competitor records |
| `decision.limitations` | Coverage and evidence gaps |
| `output.evaluation` | Evaluation state, which may still be pending |
| `output.metrics.costMicrousd` | Known provider cost; `null` means unknown, not zero |

Pending responses do not necessarily contain terminal data. See the exact
[Go output types](../cli/internal/loop/model.go) for the complete field structure.
Examples here are instructions, not live customer results.

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
