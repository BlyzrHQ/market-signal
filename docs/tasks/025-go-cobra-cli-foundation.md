# Task 025 — Go Cobra CLI foundation

## Goal

Establish a CLI-first, versioned boundary for Market Signal without claiming
that the Cloudflare-hosted TypeScript crawler can execute a Go binary.

## Architecture decision

Fable 5 reviewed the live TypeScript crawler, the v40 ten-domain evidence, the
Cloudflare runtime, and the authentication/secret boundaries. It recommended a
staged strangler migration:

1. Task 025 freezes the successful report and ads response boundaries as JSON
   Schema and adds a Go Cobra API-client CLI that validates every response.
2. A later focused task ports the first-party robots/sitemap/HTML/JSON-LD crawl
   core into Go behind the same contract and proves parity on real domains.
3. Product comparison moves after the crawler; secret-bearing competitor search
   and ads adapters remain server-side and move last.

This task establishes the CLI-first boundary. It does not claim that the crawler
has already been ported or that the hosted Worker runs Go.

## Scope

- Add versioned report, ads, and evidence JSON Schemas.
- Add `marketsignal report`, `marketsignal crawl`, `marketsignal ads`, and
  `marketsignal version` Cobra commands.
- Validate successful server responses before rendering JSON or a concise table.
- Return distinct exit codes for declared coverage gaps, contract drift, and
  transport/API/authentication failures.
- Keep provider keys and OpenAI keys out of the distributed CLI.
- Document the current scraper and the migration boundary.

## Exit codes

- `0`: valid live result with no declared gaps.
- `2`: valid live result with one or more declared gaps/access limits.
- `3`: the server returned JSON outside the versioned contract.
- `4`: transport, authentication, non-JSON, or API failure.

## Acceptance

- `go -C cli test ./...`, `go -C cli vet ./...`, and Windows/Linux/macOS
  builds pass; the CLI module does not accidentally scan JavaScript dependencies.
- `npm test` and `npm run lint` remain green.
- A real `myjam.co.uk` report response validates against the report schema and
  produces a concise summary that exposes competitors, product-comparison
  availability, pages crawled, and gaps.
- A real ads response preserves per-company/per-platform `verified-active`,
  `no-verified-result`, and `access-limited` states; missing coverage is never
  rendered as proof of zero advertising.
- The CLI reads no OpenAI or ad-provider credential.

## Current scraper

The production crawler is custom TypeScript. It uses native `fetch` with bounded
timeouts/body sizes, checks `robots.txt`, reads sitemap XML, parses public HTML
and JSON-LD, follows only same-domain crawl targets, records source URLs and
observation times, and exposes coverage gaps. It does not use Apify, Scrapy,
Playwright, Puppeteer, or an undisclosed Ads Library scraper.

## Deployment boundary

The private `chatgpt.site` deployment uses browser/proxy-injected identity and
does not currently expose a headless CLI token flow. Real CLI acceptance must
therefore name the reachable base URL used (typically local vinext with the same
server configuration). A localhost test must not be represented as production
CLI authentication.

## Validation record — 2026-07-15

- The private Sites endpoint returned HTTP `401`; the CLI returned exit code `4`
  with an authentication/HTML explanation. No browser result was represented as
  a headless CLI result.
- Local vinext at `http://localhost:3000` crawled the real public domain
  `https://myjam.co.uk/`. The report contract validated, 5/5 bounded pages were
  fetched, and 400 public product records were discovered. The command returned
  exit code `2` because competitor web search was not configured in the local
  server environment; this was shown as a gap, not hidden as success.
- The real ads command for `myjam.co.uk` and `halalo.co.uk` validated the ads
  contract and rendered Meta, Google, and TikTok as `access-limited` with
  “not established” instead of claiming zero active ads.
- The already-captured production v40 panel remains the evidence that the hosted
  configured service found three verified competitors for `myjam.co.uk`; it is
  not re-labeled as a CLI-authenticated run.

## Fable 5 strict review

- The initial strict architecture, contract, implementation, and real-data
  review returned `PASS` with no blockers.
- Review follow-ups made discovery-lane gaps affect exit code `2`, added JSON
  exit-code and transport-failure coverage, and clarified command help and ads
  exit semantics.
- Fable 5 re-read those changes, ran `go vet` and the CLI test suite without the
  test cache, and returned `FOLLOWUP_VERDICT: PASS` with no blockers.
- Remaining non-blocking limitations are the private Sites headless-auth gap,
  retrying a POST when a transient response is received, and running the Go race
  detector in Linux CI where CGO is available.

## Deployment state

No hosted application source behavior changes in this task. A Sites deployment
is therefore not required; the deliverable is the versioned contract and CLI
client boundary. The PR is stacked on the live-panel integration branch so it
must remain draft until its dependency is merged in order.
