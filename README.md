# Market Signal

Market Signal turns one domain into an evidence-backed competitive-intelligence
report: verified competitors, product-by-product comparison, market positioning,
and truthful public-ad coverage states.

## Go CLI

The Cobra CLI is the first language-neutral client of the versioned report
contracts:

```bash
go -C cli run ./cmd/marketsignal report example.com --base-url http://localhost:3000
go -C cli run ./cmd/marketsignal crawl example.com --output json
go -C cli run ./cmd/marketsignal ads example.com --competitor rival.example --region "United Kingdom"
go -C cli run ./cmd/marketsignal version
```

The domain is an argument, not a MyJam-specific value: replace `example.com`
and `rival.example` with any valid public company domains.

The default output is a compact decision summary. `--output json` returns the
validated source response. Exit code `2` means the report is valid but declares
coverage gaps; `3` means contract drift; `4` means transport, authentication, or
API failure. For ads, `no-verified-result` and `access-limited` both return `2`
because neither state establishes absence of advertising. The current Sites API
does not yet enforce a headless token or per-customer quota. Do not distribute
the CLI against it as a production API. Use `--base-url` with a controlled local
or service deployment until a scoped, rate-limited API gateway exists.

The live scraper is currently a custom robots-aware TypeScript crawler using
native fetch, sitemap XML, public HTML, and JSON-LD. It is not Apify, Scrapy,
Playwright, or Puppeteer. The crawler will move into Go only after real-domain
parity tests protect the existing production behavior.

For the complete implemented architecture, data methods, hosted configuration,
deployment sequence, and public-launch gate, see [the launch and operations
runbook](docs/LAUNCH.md).

## Web application

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
