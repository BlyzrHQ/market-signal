# Market Signal

Market Signal turns one public domain into an evidence-backed competitive
intelligence report: verified competitors, product comparisons, market
positioning, and explicit data-quality limits.

The project is open source. The hosted service runs the web application on a
VPS and uses Trigger.dev for durable background jobs.

## Run locally

Requirements:

- Node.js 22.13 or newer
- Go 1.22 or newer only when developing the optional CLI from source

Install exactly the dependency versions in the lockfile, then run the
credential-free startup check:

```bash
npm ci
npm run test:open-source
```

The smoke test starts the local web application, checks the home, pricing, and
account pages, and verifies that unconfigured account auth fails closed. It
does not create a report or contact a paid provider.

For interactive development, copy the environment template and start Vite.

macOS/Linux:

```bash
cp .env.example .env.local
npm run dev
```

PowerShell:

```powershell
Copy-Item .env.example .env.local
npm run dev
```

For durable local reports, set `MARKET_SIGNAL_SQLITE_PATH` to a writable SQLite
file and configure the server-only values documented in `.env.example`.
Provider keys are optional for UI development. A complete live report also
needs a durable SQLite path, a Trigger.dev project and callback configuration,
and the server-side provider credentials for the capabilities you enable. The
hosted Stripe and account settings are optional and remain disabled when their
documented values are absent.

The hosted CLI supports browser login and revocable workspace API keys. Normal
interactive use does not require a key. Agent loops can set
`MARKET_SIGNAL_API_KEY`; report quota and ownership remain enforced by the
hosted service. A CLI built from source can still use
`MARKET_SIGNAL_API_TOKEN` against a local or explicitly controlled service;
keep that deployment token distinct from customer keys and the Trigger
callback token.

### Run your own background workers

The repository is not connected to Blyzr's hosted Trigger.dev project. For a
complete local report, create your own Trigger.dev project, put its project ref
and development secret in `.env.local`, and run the web app and worker in
separate terminals:

```bash
npm run dev
npm run trigger:dev
```

This runs the task code on your machine. Trigger.dev still requires a control
server: use either your own Trigger.dev Cloud project or your own self-hosted
Trigger.dev instance. For self-hosting, also set `TRIGGER_API_URL`. See
[`docs/OPEN_SOURCE_SETUP.md`](docs/OPEN_SOURCE_SETUP.md) for both paths and the
security boundary.

## Validate a contribution

```bash
npm run test:open-source
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

Windows users can install the hosted CLI without Go, Node.js, or this
repository:

```powershell
irm https://signal.blyzr.com/install.ps1 | iex
marketsignal login
marketsignal report example.com
```

The CLI opens Market Signal in the browser for sign-in, stores its rotating
credential in Windows Credential Manager, and prints the private report's
competitors and priced product comparisons. The crawler and report loop run on
the Market Signal service, not inside the CLI process.

For a non-interactive agent, create a scoped key under **Account → API keys**
and provide it through the environment:

```powershell
$env:MARKET_SIGNAL_API_KEY = "your-key"
marketsignal report example.com --output json
```

To save that key in Windows Credential Manager instead, run
`marketsignal login --api-key` and paste it at the hidden prompt. Never put a
key directly in a command argument.

Contributors can still run it from source:

```bash
go -C cli run ./cmd/marketsignal --help
go -C cli run ./cmd/marketsignal version
go -C cli run ./cmd/marketsignal report example.com --base-url http://localhost:3000
```

Replace `example.com` with any valid public company domain. See
[docs/CLI.md](docs/CLI.md) for advanced commands, flags, output formats, exit
codes, local-development authentication, and troubleshooting.

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
- `npm run test:open-source` — verify first startup without private credentials
- `npm run build` — build the Node application
- `npm run build:vps` — build and assert VPS packaging boundaries
- `npm test` — typecheck, build, and run tests
- `npm run lint` — run ESLint
- `npm run trigger:deploy` — deploy Trigger tasks from an authenticated operator environment
- `npm run backup:vps` / `npm run verify-backup:vps` — create and verify SQLite backups

## License

See [LICENSE](LICENSE).
