# Market Signal

Market Signal turns one public domain into an evidence-backed competitive
intelligence report: verified competitors, product comparisons, market
positioning, and explicit data-quality limits.

The project is open source. The hosted service runs the web application on a
VPS and uses Trigger.dev for durable background jobs. There is no OpenAI Sites
runtime or fallback.

## Run locally

Requirements:

- Node.js 22.13 or newer
- Go 1.22 or newer for the optional CLI

```bash
npm install
cp .env.example .env.local
npm run dev
```

For durable local reports, set `MARKET_SIGNAL_SQLITE_PATH` to a writable SQLite
file and configure the server-only values documented in `.env.example`.
Provider keys are optional for UI development, but live competitor discovery,
matching, and report orchestration require their corresponding server-side
credentials.

## Validate a contribution

```bash
npm test
npm run lint
go -C cli test ./...
go -C cli vet ./...
```

`npm test` runs TypeScript checks, the production Node build, and the complete
Node test suite. Never commit API keys, cookies, tokens, private report data, or
deployment environment files.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Current
engineering tasks live under `docs/tasks/`; completed task files are historical
release evidence and may describe retired architecture.

## Go CLI

The CLI validates and calls a selected Market Signal HTTP service; it does not
scrape websites locally.

```bash
go -C cli run ./cmd/marketsignal --help
go -C cli run ./cmd/marketsignal version
go -C cli run ./cmd/marketsignal report example.com --base-url http://localhost:3000
```

Replace `example.com` with any valid public company domain. The hosted service
does not expose general-purpose API tokens yet, so use the CLI only against a
local or explicitly controlled deployment. See [docs/CLI.md](docs/CLI.md) for
all commands, flags, output formats, exit codes, and troubleshooting.

## Architecture

```text
Browser / CLI
  -> Node web application on the VPS
       -> SQLite report and account database
       -> bounded public-source crawler and official storefront adapters
       -> Trigger.dev durable jobs
            -> OpenAI discovery, matching, and evaluation calls
            -> authenticated callbacks to the VPS
```

Public-source facts, AI inferences, estimates, and recommendations remain
separate in saved reports. Missing prices, inaccessible pages, and unsupported
comparisons are shown as coverage limits rather than fabricated values.

See [docs/LAUNCH.md](docs/LAUNCH.md) for the production topology, configuration,
release sequence, backups, and launch gates. VPS provisioning and rollback are
documented in [deploy/vps/README.md](deploy/vps/README.md).

## Useful commands

- `npm run dev` — start local development
- `npm run build` — build the Node application
- `npm run build:vps` — build and assert VPS packaging boundaries
- `npm test` — typecheck, build, and run tests
- `npm run lint` — run ESLint
- `npm run trigger:deploy` — deploy Trigger tasks from an authenticated operator environment
- `npm run backup:vps` / `npm run verify-backup:vps` — create and verify SQLite backups

## License

See [LICENSE](LICENSE).
