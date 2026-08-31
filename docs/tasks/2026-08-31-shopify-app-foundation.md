# Task: Public Shopify app foundation

## Outcome

Implement the dormant security and lifecycle foundation for the public Shopify app described in `docs/tasks/2026-08-30-public-shopify-app-prd.md`. This slice must be safe to merge and deploy before a real Shopify app or merchant installation is connected. It does not retrieve products, create reports, consume report quota, activate price watches, reconcile Shopify billing, or expose protected merchant data.

## Scope

- Parse Shopify runtime configuration and fail closed when it is absent or malformed.
- Strictly canonicalize and validate `*.myshopify.com` installation domains.
- Verify App Bridge ID tokens with HS256 and validate `exp`, `nbf`, `aud`, `iss`, `dest`, and `sub` before any state change or token exchange.
- Exchange a verified ID token for an expiring offline access token through an injectable Shopify boundary.
- Encrypt offline and refresh tokens with AES-256-GCM using versioned keys and installation-bound authenticated data.
- Create one Shopify workspace per shop and deterministic issuer-keyed, non-credential staff identities without treating sentinel addresses as verified contact email.
- Resolve Shopify requests to the existing `{ workspaceId, userId }` actor contract using the verified shop and staff subject, not request parameters or cookies.
- Serve a minimal embedded App Home bootstrap with dynamic Shopify-only `frame-ancestors` policy and no protected data before ID-token authentication.
- HMAC-verify raw Shopify webhook bodies and process `app/uninstalled`, `app/scopes_update`, `customers/data_request`, `customers/redact`, and `shop/redact` idempotently.
- Delete usable access and refresh tokens and disable active workspace price watchers synchronously on uninstall.
- Remove the current Shopify foundation records on `shop/redact`. Later Shopify-owned data features must extend and test redaction before those features can be enabled.
- Add focused tests and include the new files in repository type checking.

## Data boundaries

- Request only `read_products`; this slice makes no Admin API catalog call.
- ID tokens, Shopify access tokens, refresh tokens, encryption keys, webhook bodies containing customer fields, and app secrets must never be logged or persisted in plaintext.
- Webhook audit rows store bounded metadata and a payload hash, never raw customer payloads.
- Shopify Admin data is authenticated first-party merchant data. This slice creates only installation and identity metadata; it creates no report facts.
- A `.invalid` sentinel email is an internal schema compatibility value. It is unverified, has no password account, and is never a notification destination.

## Proposed module boundary

- `app/lib/shopify/config.ts`: fail-closed environment parsing.
- `app/lib/shopify/shop-domain.ts`: strict shop and origin validation.
- `app/lib/shopify/id-token.ts`: bearer extraction, HS256 verification, and claim checks.
- `app/lib/shopify/token-crypto.ts`: versioned AES-256-GCM envelope.
- `app/lib/shopify/token-exchange.ts`: injectable offline token-exchange client.
- `app/lib/shopify/store.ts`: schema, installation lifecycle, actor identity mapping, and redaction.
- `app/lib/shopify/actor.ts`: request-to-actor authorization adapter.
- `app/lib/shopify/webhooks.ts`: raw-body HMAC verification, replay-safe dispatch, and lifecycle effects.
- `app/api/shopify/bootstrap/route.ts`: authenticated install/reinstall bootstrap.
- `app/api/shopify/context/route.ts`: authenticated installation/actor health response.
- `app/api/shopify/webhooks/route.ts`: single signed webhook receiver keyed by Shopify topic headers.
- `app/shopify/route.ts`: public, non-sensitive embedded shell with dynamic CSP.

## Invariants

1. A shop domain is accepted only in canonical lowercase `<label>.myshopify.com` form with no scheme, port, path, query, fragment, userinfo, wildcard, or Unicode ambiguity.
2. A verified ID token's `iss` and `dest` resolve to the same canonical shop; `aud` equals the configured client ID; `sub` is a bounded Shopify staff identifier; time claims are valid with only a small documented clock tolerance.
3. Installation creation and actor mapping are one immediate SQLite transaction. One shop has one workspace, and one `(shop issuer, staff sub)` has one user/account identity.
4. Shopify identities have no credential account and no verified email. Existing direct-web identities are never linked implicitly.
5. Token ciphertext is bound to its shop, token purpose, envelope version, and key version. Ciphertext copied between installations or purposes cannot decrypt.
6. An unconfigured deployment returns a bounded `503` response and makes no database or Shopify request.
7. A Shopify token-exchange `400` caused by a stale ID token returns `401` with `X-Shopify-Retry-Invalid-Session-Request: 1`; other upstream failures return a bounded `502` without leaking the response body.
8. Webhook HMAC verification uses the untouched raw body and a constant-time comparison. Invalid signatures return `401` before parsing or database access.
9. A webhook delivery ID can be processed once only for the same shop, topic, and payload hash. Conflicting reuse is rejected and never mutates state.
10. `app/uninstalled` clears every usable Shopify token before returning success and pauses/disables the workspace's active watchers without consuming credits.
11. Compliance webhooks never persist raw customer identifiers. `customers/data_request` and `customers/redact` record only that Market Signal stores no Shopify customer/order data.
12. The embedded shell contains no merchant data and can be framed only by `https://admin.shopify.com` and the validated shop origin.

## Endpoint behavior

### `GET /shopify?shop=<canonical-shop>`

- `503` when Shopify is not configured.
- `400` for an invalid shop.
- `200 text/html` with `Cache-Control: private, no-store`, dynamic `Content-Security-Policy`, App Bridge metadata/script, and a non-sensitive installation-status bootstrap.

### `POST /api/shopify/bootstrap`

- Requires a fresh bearer ID token; it does not trust a body/query shop value.
- Verifies the token, exchanges it for an expiring offline token, encrypts the token bundle, and idempotently creates or reconnects the shop workspace and staff actor.
- `200` for replay of the same active installation, `201` for first installation or completed reconnect, `401` for invalid/stale authentication, `502` for a bounded Shopify exchange failure, and `503` when configuration/storage is unavailable.

### `GET /api/shopify/context`

- Requires a fresh bearer ID token.
- Returns only bounded shop/workspace/actor/install-state/scope-health data.
- Returns owned-or-not-found semantics for unknown/inactive foreign installations.

### `POST /api/shopify/webhooks`

- Requires Shopify's webhook ID, topic, shop-domain, and HMAC headers plus an `application/json` raw body.
- Returns `401` for invalid HMAC, `400` for invalid metadata or payload, `404` for an unsupported signed topic, `409` for conflicting delivery-ID reuse, `200` for processed or exact duplicate deliveries, and `503` for a retryable storage failure.

## Tests

- Configuration: missing target/path/client ID/secret/key ring, short/invalid keys, invalid active version, malformed API version, and valid dormant configuration.
- Shop validation: mixed case canonicalization plus rejection of custom domains, deceptive suffixes, nested subdomains, ports, userinfo, paths, queries, fragments, IPs, Unicode, and oversized labels.
- ID tokens: valid token; missing bearer; malformed JWT; wrong algorithm/signature/audience; expired/future; missing or malformed subject; mismatched `iss`/`dest`; custom/deceptive hosts; and bounded clock tolerance.
- Encryption: round trip, random IVs, wrong key version, tampered tag/data/AAD, cross-shop swap, cross-purpose swap, and no plaintext in database rows.
- Store: first install, repeated bootstrap, reinstall, two staff in one shop, same staff-like value across shops, concurrent/idempotent mapping, no password, sentinel unverified, no duplicate workspace, and inactive/unknown actor denial.
- Token exchange: exact HTTPS host and form fields, offline expiring token type, bounded response validation, stale-token retry header, timeout/abort, and no upstream body leakage.
- Webhooks: valid signatures, invalid/missing signature, raw-body sensitivity, missing headers, unsupported topic, duplicate delivery, conflicting reuse, payload/header shop mismatch, malformed JSON, uninstall token deletion, watcher disablement, required-scope loss, no raw customer payload storage, and redaction.
- Embedded shell: no protected data, escaped client ID, no caching, correct dynamic frame ancestors, and rejection of invalid shop input.
- Regression: existing account signup, report ownership, Stripe billing, price-watch, full type checks, lint, build, and test suite.

## Validation and rollout

- Automated tests use generated test secrets, temporary SQLite databases, synthetic Shopify JWTs, and injected HTTP clients. They make no live Shopify request and consume no Market Signal credits.
- This is a high-risk authentication, authorization, credential, and data-lifecycle change. Require strict verified Fable 5 review after implementation; if unavailable for a documented platform reason, require two independent strict fallback reviews.
- The code must remain dormant when Shopify configuration is absent. Deployment can prove existing production health and fail-closed Shopify endpoints, but a real install/reinstall and Shopify CLI webhook acceptance remain blocked until the Dev Dashboard app, development store, protected credentials, and app-specific subscriptions exist.
- Never call the Shopify foundation live-complete until the exact deployed revision passes a development-store install, cross-shop isolation, token exchange, CSP, uninstall, scope-loss, and privacy webhook acceptance.

## Review record

- The merged PRD received strict verified Claude Fable 5 review and was merged by Fable at `4f7f85f91eb0a9cd1f83b433325a9f314b77e2f8`.
- A focused pre-implementation architecture review ran in a verified Claude Fable 5 session. It confirmed the single-process module boundary, runtime `ensure*Schema` convention, issuer-keyed staff principals, dynamic route-level frame policy, and no-Trigger Stage 1 rollout.
- Fable's P0 findings were incorporated: deterministic unique sentinel principals, Shopify-token-only actor resolution with no cookie fallback, one-transaction uninstall token deletion plus watcher shutdown, and dynamic per-shop CSP. Its provider-exclusivity finding is enforced with SQLite triggers that reject Stripe subscription rows for `kind = 'shopify'` workspaces. Its explicit-gate recommendation is implemented as `MARKET_SIGNAL_SHOPIFY_APP=true` plus complete fail-closed configuration.
- Fable's P1 findings were incorporated by adding every Shopify file to the repository's explicit type-check list, never creating a Better Auth session for Shopify-only actors, preserving the existing four-hour report reservation TTL, and keeping report/catalog work out of this slice.
- `npm run db:generate` was run after updating `db/schema.ts`. It exposed pre-existing snapshot drift and attempted to regenerate unrelated OAuth/account DDL, including an already-applied issuer migration. That unsafe generated migration was not retained. Production continues to use the repository's idempotent runtime `ensure*Schema` convention; the Drizzle schema remains synchronized for type/model visibility. Resolving historical snapshot drift is a separate migration-maintenance task.

## Implementation validation

- Shopify's current official App Home and token-exchange documentation was rechecked on 2026-08-31. The shell uses the documented `shopify.idToken()` API, sends the token only to the app backend, and the backend validates HS256 plus `exp`, `nbf`, `aud`, `iss`, and `dest` before exchanging it for an expiring offline token.
- The focused foundation suite passes 17/17 cases. It includes strict shop and claim validation, bounded streaming reads, AES-256-GCM isolation and tamper tests, cross-shop tenant isolation, structural Stripe exclusion, atomic uninstall handling, compliance redaction retries, no raw customer payload persistence, dynamic frame policy, and a plaintext database scan.
- `npm test` passes all 1,257 test executions across 1,242 subtests after a clean production build.
- `npm run typecheck`, `npm run typecheck:node`, `npm run build:vps`, and `npm run test:open-source` pass. The open-source smoke starts without private credentials and verifies that `/shopify` fails closed with `503 shopify_not_configured`.
- `npm run lint` reports zero errors and one pre-existing `next/image` advisory in `app/components/product-design-lab.tsx`, outside this task.
- No Shopify network request, report run, Trigger task, AI comparison, report reservation, or price-watch credit was created by validation.

## Remaining acceptance boundary

This foundation is intentionally dormant and cannot yet be called a merchant-ready Shopify app. A later credentialed acceptance step must create the public app in Shopify's Dev Dashboard, configure the exact app URL, redirect URLs, `read_products` scope, and mandatory webhooks, provide protected app and encryption credentials, install it on a development store, and verify install/reinstall, scope loss, cross-shop isolation, CSP, uninstall, and privacy webhooks against the exact deployed revision. Product import, reports, Shopify billing, token refresh jobs, and price-watch controls remain later slices.
