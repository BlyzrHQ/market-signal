# Contributing to Market Signal

Thanks for improving Market Signal. This repository contains the Node web
application, durable Trigger.dev workers, versioned report contracts, and the
optional Go CLI.

## Start from a clean checkout

Install Node.js 22.13 or newer and Go 1.22 or newer, then run:

```bash
npm ci
npm run test:open-source
```

The startup smoke deliberately runs without private credentials. It verifies
that the public UI starts and that unconfigured account features fail closed.
It does not create a report or call OpenAI, Trigger.dev, Stripe, Meta, or another
paid provider.

For interactive development, copy `.env.example` to `.env.local` and run
`npm run dev`. Keep empty every integration you are not testing. A complete
live report requires a durable SQLite path, a compatible Trigger.dev project,
the shared callback configuration, and the provider keys for the capabilities
you enable. The Trigger.dev project must belong to your installation; the
repository has no hosted Market Signal project fallback. See
`docs/OPEN_SOURCE_SETUP.md` for local workers and self-hosting, and
`docs/LAUNCH.md` for the full production topology.

## Make a focused change

1. Create a `codex/<short-task-name>` branch.
2. Add or update a focused task note under `docs/tasks/`.
3. Keep public observations, AI inferences, estimates, and recommendations
   visibly distinct.
4. Add regression coverage for behavior changes.
5. Do not use fixture data as a live customer result.

Never commit API keys, cookies, tokens, private reports, customer data, database
files, `.env.local`, or deployment credentials. Use obviously synthetic values
in tests.

## Validate before opening a pull request

```bash
npm run test:open-source
npm test
npm run lint
go -C cli test ./...
go -C cli vet ./...
```

Real-data changes must also be checked against at least one relevant public
domain, with the source, observation time, region, language, confidence, and
coverage limits preserved. Do not launch paid-provider tests from a public pull
request or ask CI to expose repository secrets.

## Pull-request checklist

Explain:

- what changed and why;
- the validation you ran;
- which statements are public facts, AI assessments, estimates, or fixtures;
- known data-source and product limitations;
- whether runtime deployment is required.

Pull requests start as drafts. They remain unmerged while checks fail or review
blockers are unresolved. Maintainers perform the production deployment; forks
and pull-request workflows receive no production credentials.
