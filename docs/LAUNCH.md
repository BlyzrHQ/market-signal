# Market Signal: architecture, operation, and launch runbook

This document describes the system that is implemented and deployed today. It
also separates the production-proven report engine from the work still required
before a public commercial launch.

## 1. Product journey

1. A visitor submits any public company domain. The domain is normalized, so
   `example.com`, `www.example.com`, and a pasted HTTPS URL are accepted as the
   same input.
2. The application creates a durable report run in D1 and immediately returns a
   public report URL. The loading page polls the saved run and shows the current
   phase instead of keeping one browser request open.
3. Trigger.dev executes the long-running report job. It crawls the submitted
   company, discovers and independently verifies likely competitors, compares
   products, checks public ad-transparency sources, and saves the final report.
4. The dashboard reads the saved report from D1. Competitors, products, ads,
   evidence, and methodology are separate views. Product comparisons can be
   exported as CSV and the report URL can be shared.
5. A report ends as `complete`, `limited`, `failed`, or `interrupted`. A
   limitation is a first-class result: an inaccessible ad library, missing
   public price, parked domain, or unavailable website is never silently turned
   into a zero or an invented claim.

## 2. Deployed architecture

```text
Browser
  -> Sites UI and API (vinext on a Cloudflare Worker)
       -> D1: report runs, events, documents, companies, products,
              matches, ads, and verified-competitor memory
       -> Trigger.dev: durable report orchestration
            -> authenticated Sites API calls
                 -> public website crawler and storefront adapters
                 -> OpenAI web search for competitor discovery
                 -> OpenAI embeddings and structured product judge
                 -> official ad-library search plus optional Meta adapters
            -> D1 final report document and phase events
  <- loading progress, then the saved dashboard
```

The production responsibilities are intentionally split:

- **Sites** serves the landing page, report dashboard, API routes, and D1
  binding. `.openai/hosting.json` declares the existing Sites project and the
  logical `DB` binding.
- **D1** is the durable SQLite-compatible database. Each run stores ordered,
  idempotent phase events and a versioned report document, plus normalized
  companies, products, matches, and ad evidence. Runs receive a 90-day
  `expires_at` value. The code does not yet contain an automated purge job, so a
  deletion/retention job is a launch requirement before advertising automatic
  deletion.
- **Trigger.dev** owns long-running orchestration. The report queue has a
  concurrency limit of four, a 15-minute per-run ceiling, and at most two
  attempts for the report task. Sites and Trigger authenticate their internal
  callbacks with the same server-only token.
- **OpenAI** provides bounded web search, text embeddings, and structured AI
  judgments. It does not replace source collection: accepted competitors,
  products, prices, images, and ads still require public evidence.
- **Go/Cobra CLI** is a contract-validating client for the HTTP service. The
  production crawler remains TypeScript inside the Sites application; the Go
  binary does not perform the crawl locally.

Current private deployment:
`https://market-signal.abdulla617931.chatgpt.site`

## 3. How the intelligence methods work

### Website and catalog collection

The crawler uses native `fetch` with bounded timeouts and response sizes. It
checks `robots.txt`, reads same-domain sitemap XML, follows a bounded set of
same-domain pages, and extracts public HTML, metadata, JSON-LD, links, region
signals, prices, and product records. It uses a clear Market Signal user agent
and records source URL and observation time.

Catalog recovery is layered because stores expose data differently:

1. JSON-LD `Product` and offer data on product pages.
2. Product metadata, including Open Graph/Twitter images and price metadata.
3. Product URLs and image titles from public sitemaps.
4. Public Shopify product JSON for an attributable product handle.
5. Public WooCommerce Store API lookup for an attributable product slug.
6. A final bounded re-read of selected matched product pages for prices and
   images.

Every fallback validates product identity. A price is accepted only with a
positive amount and confirmed currency. A direct price difference is shown only
when the products are judged to be the same product and currency, pack/variant,
and billing basis align. Otherwise the dashboard says the comparison basis is
unverified.

### Competitor discovery and verification

Discovery uses the submitted company's first-party category, products, region,
and language to build several searches: company/category searches and
recurrence-ranked product-family searches. OpenAI Responses web search returns
candidate domains and source URLs.

Candidates are not displayed merely because search or AI named them. Each
candidate website is crawled and scored using first-party evidence for entity
identity, category alignment, region compatibility, and product overlap. A
candidate must pass the verification threshold. Country storefront conflicts
remain investigation gaps instead of becoming competitors. Recently verified
competitors can be remembered in D1 for 30 days, but are re-crawled and
re-verified before reuse.

### Product matching

The current matcher is hybrid rather than name-only:

1. Normalize multilingual product names, quantities, units, brands, categories,
   and product type signals.
2. Synchronize bounded primary and competitor catalogs.
3. Retrieve plausible pairs with lexical indexes and
   `text-embedding-3-small` semantic vectors.
4. Ask `gpt-5.4-mini` for a strict structured verdict such as `same_product`,
   `close_substitute`, or `not_comparable`, with reasons tied to the observed
   records.
5. Apply deterministic vetoes for contradictory product type, incompatible
   quantities/units, service-versus-product conflicts, unsupported identities,
   and unsafe price comparisons.
6. Enrich the selected pages again and persist accepted matches plus visible
   gaps.

If embeddings or AI judging are unavailable, lexical retrieval can preserve
coverage signals, but the report does not silently present unassessed pairs as
AI-verified matches.

### Advertising intelligence

The ads lane checks the submitted company and verified competitors separately.
It supports:

- OpenAI web search restricted to official Meta, Google, and TikTok transparency
  domains;
- an optional official Meta Ads Archive token where Meta provides relevant
  commercial coverage; and
- a temporary optional Meta exact-Page provider, accepted only when the Page is
  attributable from the company's own website and returned Page IDs match.

The stored states are `verified-active`, `no-verified-result`, and
`access-limited`. A `no-verified-result` is not proof that a company runs zero
ads. Exact ordinary-commercial-ad spend is not publicly available and is never
invented. The temporary unofficial Meta provider must be replaced or
contractually approved before relying on it as a core paid feature.

## 4. Go CLI

The commands accept any valid public domain; `myjam.co.uk` is only a test
example.

```bash
go -C cli run ./cmd/marketsignal report example.com --base-url http://localhost:3000
go -C cli run ./cmd/marketsignal crawl example.com --output json
go -C cli run ./cmd/marketsignal ads example.com --competitor rival.example --region "United Kingdom"
go -C cli run ./cmd/marketsignal version
```

For a built binary, replace `go -C cli run ./cmd/marketsignal` with
`marketsignal`.

- `report` runs the synchronous report contract and prints the decision summary.
- `crawl` runs the same current API pipeline but emphasizes crawl coverage.
- `ads` checks the supplied company set; competitor flags are repeatable.
- `version` prints the binary version injected at build time.
- `--output json` returns the validated source response.
- Exit `0` means a valid result with no declared gaps, `2` means a valid result
  with explicit coverage limits, `3` means JSON contract drift, and `4` means a
  transport, authentication, or API failure.

The current deployment does not have application-owned API authentication.
Saved report endpoints respond without a user session; access is effectively a
capability URL on an unlisted origin with a random 128-bit report ID. Sites can
inject identity headers for signed-in workspace visitors, but the report API
does not currently require those headers. This is not an ownership or
authorization boundary, and anyone who receives a report URL can read it.

The synchronous CLI-facing routes also have no scoped token or per-customer
quota. Controlled headless requests may work technically, but distributing the
CLI against this deployment would expose an unauthenticated paid-work surface.
Public CLI distribution therefore waits for a token-authenticated, rate-limited
API gateway and explicit report access policy.

## 5. Local operation

Prerequisites are Node.js 22.13 or newer and Go for the CLI.

```bash
npm install
npm run dev
npm test
npm run lint
go -C cli test ./...
go -C cli vet ./...
```

`npm test` includes TypeScript checking, the production build, and the Node test
suite. Store local secrets outside Git. Never put provider credentials in
`.openai/hosting.json`, frontend code, the Go CLI, task documents, or PR bodies.

## 6. Hosted configuration

Configure secrets in both runtimes, not in Git.

### Sites environment

Required for the current full pipeline:

- `OPENAI_API_KEY`
- `TRIGGER_SECRET_KEY`
- `MARKET_SIGNAL_CALLBACK_TOKEN` (a random value of at least 32 characters)

Recommended explicit model/runtime values:

- `MARKET_SIGNAL_MODEL=gpt-4o-mini` and
  `OPENAI_BASE_URL=https://api.openai.com/v1/chat/completions` for the legacy
  synchronous market-brief contract used by the current CLI path
- `MARKET_SIGNAL_DISCOVERY_MODEL=gpt-5.4-mini`
- `MARKET_SIGNAL_MATCH_MODEL=gpt-5.4-mini`
- `MARKET_SIGNAL_MATCH_EMBEDDING_MODEL=text-embedding-3-small`
- `MARKET_SIGNAL_AD_MODEL=gpt-5.4-mini`
- `OPENAI_RESPONSES_BASE_URL=https://api.openai.com/v1`

Optional adapters:

- `META_AD_LIBRARY_ACCESS_TOKEN`
- `METAPI_API_KEY` (temporary provider; see the ads limitation above)

### Trigger environment

- `MARKET_SIGNAL_APP_ORIGIN` set to the exact HTTPS Sites origin (and changed to
  the custom production origin when the worker is moved there)
- `MARKET_SIGNAL_CALLBACK_TOKEN` with exactly the same value as Sites

`TRIGGER_SECRET_KEY` authorizes Sites to submit a Trigger run. The callback
token authorizes Trigger to read and update only the internal report endpoints.
They are different credentials and should be independently rotated.

### Deployment sequence

1. Merge only a reviewed commit that passes Node and Go validation.
2. Build the exact commit.
3. Generate and inspect a Drizzle migration whenever `db/schema.ts` changes.
4. Push the exact commit to the Sites source repository, package the built
   Worker and migrations, save a Sites version, and deploy it.
5. Deploy the same commit's Trigger tasks.
6. Verify the Sites deployment status, Trigger task registration, D1 binding,
   and runtime environment values.
7. Submit one real domain and verify the loading transition, terminal D1 run,
   product images/prices, source links, ad states, export, share, desktop/mobile
   layout, and Arabic mode.

When the custom domain is supplied, connect it to the validated Sites deployment
and update `MARKET_SIGNAL_APP_ORIGIN` in Trigger. Keep the existing private URL
as a rollback/verification target until the custom domain passes the same live
gate.

## 7. What is production-proven today

- A real five-domain ecommerce acceptance matrix passed in production.
- The final MyJam regression produced five verified competitors, 40 accepted
  product pairs, 80 secure product images, and source-verified prices without
  unsafe zero-price or cross-variant deltas.
- Parked and unavailable domains persist truthful limited reports instead of
  fabricating intelligence.
- The dashboard, durable loading flow, D1 persistence, Trigger orchestration,
  CSV export, share control, source links, and English/Arabic report shell are
  deployed privately.
- Fable 5 has acted as the strict review and merge gate, while Codex separately
  ran the tests and production checks.

This proves a useful private beta for ecommerce catalogs. It does not yet prove
equal recall for every global industry, complete ad coverage, or public SaaS
operability.

## 8. Public-launch gate

### Must complete before opening anonymous traffic

1. **Authentication and ownership:** add user accounts/workspaces, associate
   reports with owners, and enforce which report URLs may be public. Today,
   anyone holding a random report URL can read that report.
2. **Abuse and cost controls:** rate-limit domain submissions by identity and IP,
   add quotas and concurrency controls per plan, reject internal/private network
   targets, and cap daily provider spend.
3. **Billing and entitlement:** implement free-report eligibility, trial state,
   subscription tiers, usage metering, and payment-webhook reconciliation.
4. **Retention and deletion:** add the D1 expiry purge, account deletion, export,
   and a documented retention policy. The existing `expires_at` field alone is
   not deletion.
5. **Provider/legal review:** confirm robots/terms posture, privacy disclosures,
   data-processing terms, and whether the temporary Meta provider may be used in
   a commercial product. Keep exact-spend claims disabled.
6. **API/CLI authentication:** issue scoped service tokens through an API gateway
   before distributing the CLI. Do not reuse browser identity headers.
7. **Reliability:** add centralized error reporting, structured metrics,
   provider-cost telemetry, queue/run alerts, D1 backup/recovery checks, and a
   runbook for stale or failed reports.
8. **Coverage benchmarks:** expand the acceptance matrix beyond food ecommerce
   to SaaS, agencies, multilingual stores, large catalogs, and intentionally
   hostile/JavaScript-only storefronts. Track competitor precision, catalog
   recall, accepted-match precision, price/image coverage, report latency, and
   cost per completed report.
9. **Customer controls:** allow region correction, competitor include/exclude,
   monitoring cadence, notification channels, and evidence-level feedback.
10. **Custom domain and policy pages:** connect the production hostname and add
    terms, privacy, acceptable use, contact/support, and source-correction flows.

### Recommended launch stages

- **Now — owner-only alpha:** continue product-quality testing on the private
  Sites URL.
- **Next — invite-only beta:** add identity, per-user quotas, monitoring, and
  observability; onboard a small set of ecommerce operators and agencies.
- **Then — paid beta:** add billing, retention/deletion automation, provider
  agreements, and support operations.
- **Public launch:** open the custom domain only after abuse, cost, legal,
  reliability, and data-quality gates have measured owners.

The highest-value next product feature is recurring monitoring with change
alerts: preserve a baseline catalog/competitor/ad snapshot, re-run on a chosen
schedule, and notify only when a source-backed change is material. That turns a
one-time report into the market-monitoring product originally requested.
