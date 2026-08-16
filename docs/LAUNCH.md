# Market Signal architecture and launch runbook

This runbook describes the supported production system. Completed task files
under `docs/tasks/` are historical records and can mention retired platforms.

## Product journey

1. A signed-in customer submits a public company domain.
2. The VPS application creates a durable SQLite report run, reserves the plan's
   run and product allowance, and returns a private report URL.
3. Trigger.dev executes the long-running report job and sends authenticated
   phase updates and terminal results back to the VPS.
4. The report engine collects bounded public evidence, discovers and verifies
   competitors, enriches product pages, accepts only supported comparisons, and
   records explicit coverage gaps.
5. The dashboard reads the saved report. A run ends as `complete`, `limited`,
   `failed`, or `interrupted`; billing reservations are committed or released
   according to that terminal state.
6. The report evaluator runs independently and saves strengths, weaknesses,
   proposed improvements, and any human-review question.

## Production architecture

```text
Browser / CLI
  -> Caddy TLS proxy at signal.blyzr.com
       -> Node web application (immutable container image)
            -> SQLite: accounts, workspaces, billing, reports, evidence, evals
            -> bounded public crawler and official storefront adapters
            -> Trigger.dev report/evaluation/retention tasks
                 -> authenticated internal VPS routes
                 -> OpenAI discovery, embeddings, structured judgments, evals
                 -> public sources allowed by each collector's policy
```

The VPS is the only supported web runtime. Trigger.dev is the durable job
coordinator, not the customer-facing host. Both use the same callback-token
contract, while Trigger submission uses its own secret. Caddy terminates TLS;
the application port stays private.

SQLite uses WAL mode and online verified backups. Runtime data lives outside the
container under `/var/lib/market-signal`; backups live under
`/var/backups/market-signal` and must also be copied to encrypted off-host
storage.

## Intelligence boundaries

The crawler uses bounded timeouts, response limits, a clear user agent, robots
checks, same-domain sitemap and page discovery, and source attribution. Product
recovery can use public JSON-LD, metadata, sitemaps, attributable Shopify or
WooCommerce endpoints, selected product-page rereads, and eligible official
storefront adapters such as Salla's public MCP catalog.

Search and AI may propose competitors or product pairs, but publication still
requires independently collected evidence. A direct price delta requires
positive prices, supported currencies, and aligned product identity, quantity,
variant, and billing basis. Missing evidence is a visible limit, never zero.

## Required configuration

Keep all values out of Git.

### VPS

- `MARKET_SIGNAL_DEPLOY_TARGET=node`
- `MARKET_SIGNAL_SQLITE_PATH`
- `MARKET_SIGNAL_APP_ORIGIN=https://signal.blyzr.com`
- `MARKET_SIGNAL_CALLBACK_TOKEN`
- `TRIGGER_SECRET_KEY`
- `OPENAI_API_KEY` and the explicit model variables in `.env.example`
- `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`
- Stripe restricted key, signed webhook secret, and plan price IDs when hosted
  billing is enabled
- owner and monitor tokens for the restricted evaluation-feedback queue

### Trigger.dev

- `MARKET_SIGNAL_APP_ORIGIN=https://signal.blyzr.com`
- the exact same `MARKET_SIGNAL_CALLBACK_TOKEN` as the VPS
- provider/model values required by Trigger-owned tasks

The callback token authorizes only internal report operations. It is not a
browser credential and is distinct from the Trigger secret.

## Release sequence

1. Work on a focused `codex/*` branch with a task file under `docs/tasks/`.
2. Run Node and Go validation and obtain the required strict review on the exact
   PR head.
3. Merge only with no blockers, unresolved conversations, or failing checks.
4. Deploy Trigger tasks first when shared contracts or task code changed.
5. Dispatch `.github/workflows/deploy-vps.yml` with the full approved `master`
   revision. The workflow builds an immutable GHCR image, verifies its revision
   label and digest, uses the restricted deployment account, takes a verified
   backup, and deploys without rebuilding on the VPS.
6. Verify the deployed revision, container health, TLS lifetime, landing page,
   account session, billing capability, and authenticated internal capability.
7. Run at least one real public domain whenever collection behavior changes.
   Check terminal status, plan/product limit, source links, price/currency
   validity, images, comparisons, evaluation state, and billing accounting.

Use [deploy/vps/README.md](../deploy/vps/README.md) for provisioning, backup,
restore, rollback, and the GitHub Actions handoff.

## Launch gates

Before general public traffic, verify:

- account ownership and private/public report policy;
- Stripe Checkout, signed webhooks, Customer Portal, entitlement changes, and
  retry/idempotency behavior in test mode and then live mode;
- per-plan run and product limits, rate limits, concurrency limits, SSRF
  defenses, and daily provider-spend ceilings;
- automated retention, account deletion/export, encrypted off-host backups, and
  a tested restore;
- robots/terms, privacy, data-processing, correction, acceptable-use, and
  support policies;
- error monitoring, structured metrics, provider-cost telemetry, queue alerts,
  stale-run recovery, and an incident runbook;
- measured coverage across ecommerce, SaaS, agencies, multilingual sites, large
  catalogs, JavaScript-heavy stores, and intentionally blocked storefronts;
- competitor precision, catalog recall, match precision, price/image coverage,
  report latency, evaluation quality, and cost per completed run.

Do not call a release complete from local output alone. Verify the exact live
revision and a saved real-data result.
