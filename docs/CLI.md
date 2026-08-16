# Market Signal CLI guide

The Market Signal CLI turns a public company domain into terminal-friendly
competitive-intelligence output. It is a Go client for the Market Signal HTTP
API: the crawler, competitor discovery, product matching, and ad checks run on
the API service, not inside the CLI process.

## Before you begin

You need:

- [Go 1.22 or newer](https://go.dev/dl/)
- Node.js 22.13 or newer only when running the API locally
- this repository checked out locally

Verify the tools from the repository root:

```bash
go version
node --version
```

You do not need to learn Go to use the CLI from source. In a command such as
`go -C cli run ./cmd/marketsignal version`:

- `go` starts the Go toolchain;
- `-C cli` runs it from this repository's `cli/` directory;
- `run ./cmd/marketsignal` builds a temporary binary and runs it.

Go downloads the CLI dependencies automatically on the first run.

## Start safely

Help and version commands are local and do not create a report or use paid API
resources:

```bash
go -C cli run ./cmd/marketsignal --help
go -C cli run ./cmd/marketsignal version
```

When run from source, `version` prints `dev`. Release builds can inject a
specific version.

Commands that create reports need a running Market Signal API. For local
development, use two terminals from the repository root.

Terminal 1 — install dependencies and start the API:

```bash
npm install
npm run dev
```

Terminal 2 — run a report against that local API:

```bash
export MARKET_SIGNAL_API_TOKEN="replace-with-a-random-value-at-least-32-characters"
go -C cli run ./cmd/marketsignal report example.com
```

Set the same `MARKET_SIGNAL_API_TOKEN` value in the API server's `.env.local`
before starting it. Use a random value of at least 32 characters and keep it
separate from `MARKET_SIGNAL_CALLBACK_TOKEN`. In PowerShell, set it with
`$env:MARKET_SIGNAL_API_TOKEN = "..."` for the CLI process. The CLI reads the
token only from the environment so it does not appear in command history or the
process list. When a token is configured, remote API URLs must use HTTPS;
plain HTTP is accepted only for loopback development.

The default service URL is `http://localhost:3000`. Replace `example.com` with
any valid public company domain. The command rejects localhost, private IP
addresses, and malformed domains as analysis targets.

> **Current distribution boundary:** do not point a publicly distributed CLI at
> the production deployment. It does not yet provide scoped headless tokens or
> per-customer quotas. Use a local or otherwise controlled service deployment.
> Report, crawl, and ads commands can consume the AI and provider resources
> configured on that service.

## Commands

### `report`

Build a live competitive-intelligence report and print its decision summary.

```bash
go -C cli run ./cmd/marketsignal report example.com
go -C cli run ./cmd/marketsignal report https://example.com --output json
```

The domain can be a bare hostname or an HTTP/HTTPS URL. A leading `www.` is
normalized away. JSON output is validated against the versioned report
contract before it is printed.

### `crawl`

Run the same report pipeline as `report`, but emphasize crawl coverage in the
human-readable output.

```bash
go -C cli run ./cmd/marketsignal crawl example.com
go -C cli run ./cmd/marketsignal crawl example.com --output json
```

This is not a separate local Go scraper. Both `report` and `crawl` call the
service's `/api/crawl` endpoint.

### `ads`

Check attributable public ad-library evidence for a primary company and,
optionally, one or more known competitor domains.

```bash
go -C cli run ./cmd/marketsignal ads example.com --region "United Kingdom"
go -C cli run ./cmd/marketsignal ads example.com \
  --competitor rival-one.example \
  --competitor rival-two.example \
  --region "United Kingdom"
```

`--competitor` is repeatable. A specific country generally gives the ad
provider better regional context than the default `Global market`. Public
coverage can be limited; an empty or inaccessible library does not prove that a
company has no advertising.

### `version`

Print the CLI version without contacting the API:

```bash
go -C cli run ./cmd/marketsignal version
```

### `completion`

The Cobra framework can generate shell-completion scripts. See the help for
your shell before installing one:

```bash
go -C cli run ./cmd/marketsignal completion --help
```

## Global flags

Global flags work with `report`, `crawl`, and `ads`.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--base-url <url>` | `http://localhost:3000` | Market Signal service to call. |
| `--timeout <duration>` | `1m30s` | Maximum HTTP request duration, using Go duration syntax such as `30s` or `2m`. |
| `--output table\|json`, `-o` | `table` | Readable summary or validated source JSON. |
| `--quiet` | off | Hide progress messages written to standard error. |
| `--help`, `-h` | — | Show help without making an API request. |

Instead of repeating `--base-url`, set it for the current shell.

macOS/Linux:

```bash
export MARKET_SIGNAL_BASE_URL=http://localhost:3000
```

PowerShell:

```powershell
$env:MARKET_SIGNAL_BASE_URL = "http://localhost:3000"
```

An explicit `--base-url` value takes precedence over the default loaded from
the environment.

## Output and exit codes

The table format is designed for people. JSON is intended for scripts and is
printed only after the API response passes the repository's versioned schema.
Progress messages go to standard error, so JSON on standard output remains
pipe-friendly. Use `--quiet` to suppress progress entirely.

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Valid result with no declared coverage gap. | Use the result normally. |
| `1` | Invalid command usage or domain input. | Read the error and run the command with `--help`. |
| `2` | Valid result with an explicit coverage limitation. | Keep the result, but read its gaps before making a decision. |
| `3` | The API response did not match the expected contract. | Update the CLI/contracts together or investigate service drift. |
| `4` | Transport, authentication, configuration, or API failure. | Check the service URL, server health, access policy, and timeout. |

For `ads`, both `no-verified-result` and `access-limited` return code `2`.
Neither state establishes that advertising is absent.

## Build a reusable binary

Running from source is simplest while contributing. To create a reusable local
binary:

macOS/Linux:

```bash
go -C cli build -o ../bin/marketsignal ./cmd/marketsignal
./bin/marketsignal --help
```

PowerShell:

```powershell
go -C cli build -o ..\bin\marketsignal.exe ./cmd/marketsignal
.\bin\marketsignal.exe --help
```

After placing the binary on your `PATH`, replace
`go -C cli run ./cmd/marketsignal` in the examples with `marketsignal`.

## Troubleshooting

### Connection refused or exit code 4

The CLI defaults to `http://localhost:3000`. Start the local API with
`npm run dev`, or pass the URL of a controlled deployment with `--base-url`.

### The command returned code 2 even though output appeared

Code `2` deliberately means the response is valid but incomplete. Inspect the
coverage or limitation text in the table, or rerun with `--output json` to see
the structured gaps.

### The request timed out

Long-running public-source analysis can exceed the 90-second default. If the
service is healthy and the request is expected to take longer, use a bounded
increase such as `--timeout 3m`.

### JSON automation receives progress text

JSON is written to standard output and progress goes to standard error. In
automation, capture the streams separately or add `--quiet`.

### Production authentication fails

The current hosted product is not a supported public CLI API. Do not work
around its access controls. Use a local or explicitly authorized controlled
deployment until scoped CLI tokens, quotas, and report ownership are available.

## Contributing to the CLI

Run these checks from the repository root:

```bash
go -C cli test ./...
go -C cli vet ./...
go -C cli run ./cmd/marketsignal --help
go -C cli run ./cmd/marketsignal report --help
go -C cli run ./cmd/marketsignal crawl --help
go -C cli run ./cmd/marketsignal ads --help
go -C cli run ./cmd/marketsignal version
```

The contracts are maintained in `contracts/`. A server response that violates
them exits with code `3`; update the API, schema, CLI validation, tests, and
documentation as one reviewed change.

For application architecture, deployment, data-source limits, and the public
launch gates, read the [launch and operations runbook](LAUNCH.md).
