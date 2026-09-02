# Open-source setup

This guide keeps an open-source installation independent from the hosted
Market Signal service. Your installation must use your own database, provider
keys, callback token, and Trigger.dev project or instance.

## 1. Verify the credential-free application

```bash
npm ci
npm run test:open-source
```

The smoke test starts the web application without private credentials and
checks its public pages and fail-closed account-auth response. It does not make
paid provider calls or create a report.

## 2. Configure local application access

Copy `.env.example` to `.env.local`. Generate separate random values of at
least 32 characters for `MARKET_SIGNAL_API_TOKEN` and
`MARKET_SIGNAL_CALLBACK_TOKEN`. Set a writable `MARKET_SIGNAL_SQLITE_PATH`.

## 3. Choose your own Trigger.dev control server

Trigger.dev task code runs locally with `npm run trigger:dev`, but Trigger.dev
does not support fully offline development. Scheduling still uses a Trigger.dev
server. Choose one of these installation-owned options:

### Your own Trigger.dev Cloud project

1. Create a project in your Trigger.dev account.
2. Set its project reference as `TRIGGER_PROJECT_REF` in `.env.local`.
3. Set that project's development secret as `TRIGGER_SECRET_KEY`.
4. Keep `TRIGGER_API_URL` empty.

### Your own self-hosted Trigger.dev instance

1. Deploy and secure the Trigger.dev webapp and worker containers by following
   the official self-hosting guide.
2. Log the CLI into that instance with its `--api-url` option.
3. Set `TRIGGER_API_URL`, `TRIGGER_PROJECT_REF`, and `TRIGGER_SECRET_KEY` to
   values owned by your instance.

Never use a Blyzr project reference or credential. The repository intentionally
contains no hosted fallback.

## 4. Run locally

Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
npm run trigger:dev
```

Use `npm run trigger:deploy` only when you deliberately want to deploy tasks to
your own selected Trigger.dev project or self-hosted instance.

## 5. Validate the CLI boundary

Set the same `MARKET_SIGNAL_API_TOKEN` in the web process and CLI shell, then:

```bash
go -C cli run ./cmd/marketsignal crawl books.toscrape.com --base-url http://localhost:3000 --timeout 3m
```

The command may return a limited-data exit status for a sparse or unsupported
catalog, but it must authenticate, validate the response contract, and show
observed crawl coverage instead of returning HTTP 401.

For loop-to-loop use, the same controlled token can submit and resume one
durable report command:

```bash
go -C cli run ./cmd/marketsignal submit books.toscrape.com --request-id local:books:001 --output json
go -C cli run ./cmd/marketsignal wait <public-report-id> --request-id local:books:001 --output json
```

`submit` can start paid provider work configured on your installation. It is
not automatically retried. Reuse the exact request id after an ambiguous
response; the server returns the original command. When persistence succeeded
but no dispatch receipt exists, it repeats only the idempotent dispatch for that
same report so the command cannot remain stranded. The shared token is accepted
only when hosted billing is off.
