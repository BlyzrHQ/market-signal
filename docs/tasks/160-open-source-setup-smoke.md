# Task 160 — open-source setup smoke test

## Goal

Make the documented contributor path reproducible from a clean checkout and
prevent changes that leave the local web application or Go CLI impossible to
start without private production credentials.

## Initial clean-room findings

- `npm ci` completed from a tracked-file-only checkout on Windows with Node
  22.18.0 and npm 10.9.3.
- The first `npm run dev` page request returned HTTP 500 because Vite tried to
  transform the native `better-sqlite3` package instead of leaving it external
  to the server runtime.
- `README.md` linked to missing `CONTRIBUTING.md` and `LICENSE` files.
- There was no pull-request workflow exercising the documented Node and Go
  contribution checks.
- The documented local Go CLI path returned HTTP 401 because protected analysis
  endpoints had no separate CLI credential contract.
- `trigger.config.ts` bound every checkout to the hosted Market Signal
  Trigger.dev project instead of requiring an installation-owned project.
- A credential-free checkout must render the public UI and fail closed for
  account auth. It cannot create a durable live report until SQLite, Trigger,
  and the selected provider credentials are configured.

## Scope

- Add a cross-platform, credential-free local startup smoke test.
- Keep `better-sqlite3` external in Vite SSR development as it is in the Node
  runtime.
- Document clean installation, optional service integrations, and contribution
  expectations.
- Add least-privilege CI for the startup smoke, Node checks, and Go CLI checks.
- Add an opt-in, environment-only API token for the CLI without exposing
  Trigger-only worker endpoints or reusing the callback token.
- Require the installer to select their own Trigger.dev Cloud project or
  self-hosted Trigger.dev instance, with local task execution and no hosted
  Market Signal fallback.
- Decide and add an OSI-approved license before claiming the repository is
  legally open source.

## Acceptance criteria

- A clean checkout can run `npm ci` and `npm run test:open-source` without any
  API, Trigger, Stripe, account, or deployment secrets.
- `/`, `/pricing`, and `/account` return HTTP 200 in that smoke environment.
- unconfigured account auth returns a structured HTTP 503 rather than crashing
  the app.
- `npm test`, `npm run lint`, `go -C cli test ./...`, and `go -C cli vet ./...`
  pass.
- CI runs the same checks for pull requests and pushes to `master` with no
  write permission or repository secrets.
- README and contribution documentation distinguish UI-only local startup from
  a full live-report deployment.
- No concrete hosted Trigger.dev project reference or secret ships in the
  open-source tree.

## Data and security boundary

The setup smoke never launches a report and blanks every provider or runtime
credential in its child process. Real public-domain validation is run
separately and is never represented as a credential-free capability.

## Validation

- `npm run test:open-source`: passed with no private credentials; home,
  pricing, account, and fail-closed account auth were verified.
- `npm run trigger:dev -- --help`: passed without a project credential.
- `npm test`: 877 tests passed; build and both TypeScript checks passed.
- `npm run lint`: passed with two pre-existing `no-img-element` warnings and no
  errors.
- `go -C cli test ./...` and `go -C cli vet ./...`: passed.
- Real public-domain CLI check against `books.toscrape.com`: authenticated,
  validated contract v1, fetched 4 of 5 planned pages, and returned an honest
  limited-data status with five declared gaps instead of the former HTTP 401.
- Fresh clone of pushed commit `e8e8c3c60e9ddf929d4be92126350f2c866d66a6`:
  `npm ci`, credential-free startup, Trigger CLI help, and all Go tests passed
  without relying on untracked workspace files or private credentials.
- Dependency audit remains a separate follow-up: the current locked dependency
  tree reports no critical advisories but includes upstream low, moderate, and
  high advisories that require coordinated framework/Trigger upgrades.
- Fable 5's first exact-head review returned `STRICT PASS — no blockers` and
  suggested three low-risk hardening items. This branch additionally declares
  Apache-2.0 in package metadata, scrubs the historical hosted Trigger project
  identifier, and prevents the CLI from sending its bearer token over remote
  plain HTTP. A new exact-head pass is required after these improvements.

## Review note

The initial verified Fable 5 product review recommended Apache-2.0 for an
open-source repository that accepts external contributions. Exact-head code
and security review is still required before merge.
