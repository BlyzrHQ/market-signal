# PRD: Public Shopify app for Market Signal

Tracking issue: https://github.com/BlyzrHQ/market-signal/issues/209

## Problem Statement

Market Signal currently asks a merchant to enter a domain, discovers the merchant's public catalog, searches the public web for priced rival products, and produces a private competitive-intelligence report with optional price watches. This works as a standalone web product, but Shopify merchants must leave Shopify, create a separate Market Signal account, re-enter a domain that Shopify already knows, and depend on public crawling for their own catalog.

That creates unnecessary friction and weakens the most authoritative side of the comparison. A public Shopify app can identify the installed shop, read its product catalog directly with the merchant's consent, and let the merchant create reports and manage price watches from Shopify Admin. The app must not fork Market Signal's report engine, product entitlements, report ownership, or monitoring-credit logic. A report started from Shopify and one started from the web product must follow the same comparison, evidence, quota, privacy, and data-quality rules.

The app is intended for public Shopify App Store distribution so any eligible merchant can install it. This makes authentication, app billing, mandatory webhooks, uninstall handling, privacy deletion, least-privilege scopes, embedded-app behavior, and App Store review part of the product—not optional deployment details.

## Solution

Build Market Signal as an embedded public Shopify app hosted inside the existing production application and deployment. Installation creates or reconnects one Shopify-owned Market Signal workspace for the shop. Shopify App Bridge session tokens authenticate every embedded request; the app does not rely on third-party cookies and does not ask the merchant to create a Market Signal password.

Request only the `read_products` Admin API scope. On demand, retrieve a bounded snapshot of active, published Shopify products and variants through the GraphQL Admin API. Store the source, observation time, shop currency, locale, and first-party status with each imported product. Send that authenticated catalog snapshot to the existing Trigger.dev report workflow, which remains responsible for public rival search, priced comparison creation, report persistence, and terminal status. Installation itself never launches a report, spends report quota, or activates price watches.

The embedded App Home provides catalog coverage, plan selection, exact report impact, explicit report confirmation, private report history, report status, comparison views, item-level price watches, rival-level price watches, notification history, and monitoring-credit impact. Shopify App Pricing is the only billing provider for Shopify-created workspaces; Stripe remains the billing provider for direct web workspaces. A durable store constraint prevents one workspace from attaching both providers.

Reports remain private to the installing shop. A report becomes anonymously accessible only after an authorized merchant explicitly creates a share link. Sharing warns that the report contains first-party Shopify catalog facts and retains clear labels for authenticated merchant data, public rival facts, inferences, estimates, and recommendations.

## Product Defaults Approved for Planning

The following defaults make the first release implementation-ready. They can be changed before the corresponding implementation stage begins, but they are not left ambiguous in the design.

- Distribution: public Shopify App Store app for any merchant, subject to Shopify review.
- Surface: embedded Shopify App Home inside the existing Market Signal application; no second application service or database.
- Scope: `read_products` only. No customers, orders, inventory, discounts, themes, or protected customer data.
- Plans: mirror the current Starter, Solo, Growth, and Agency monthly plan names, prices, report limits, comparison limits, and monitoring-credit limits in Shopify App Pricing.
- Trial: free installation and catalog preview, but no free paid-work trial in v1. A Shopify subscription is required before a report or price watch can consume capacity.
- Account model: the installed shop owns the workspace. Shopify staff authenticate with Shopify; no Market Signal password or v1 account-linking flow.
- Reinstall: reinstall before Shopify's shop-redaction event reconnects the existing disabled workspace; reinstall after completed redaction creates a fresh workspace.
- Sharing: explicit share links may contain the report's first-party catalog facts, but the confirmation warns the merchant and the shared view keeps the source labels visible.
- Localization: English App Store listing and embedded application UI in v1; report output can use the existing English or Arabic report locale.
- Catalog freshness: snapshot on merchant preview/confirmation rather than a continuous product-webhook mirror. Scheduled refreshes occur only for explicitly activated price-watch targets.

## User Stories

### Installation, identity, and access

1. As a Shopify merchant, I want to install Market Signal from the Shopify App Store, so that I can use it on my store without a separate sales process.
2. As a Shopify merchant, I want the permission screen to request only product-read access, so that I do not grant access to customers, orders, or store configuration.
3. As a Shopify merchant, I want installation to create no report and spend no quota or credits, so that installing the app is safe to evaluate.
4. As a Shopify merchant, I want the app to recognize my shop automatically, so that I do not have to type my own domain.
5. As a Shopify staff member, I want to enter the app through my Shopify session, so that I do not need a Market Signal password.
6. As a shop owner, I want staff activity attributed to the Shopify staff identity that performed it, so that report and monitoring changes are auditable.
7. As a shop owner, I want staff from another shop to be unable to discover whether my reports or watchers exist, so that shop data cannot be enumerated.
8. As a merchant whose browser blocks third-party cookies, I want the embedded app to continue working, so that Shopify Admin behavior does not depend on cookie exceptions.
9. As a returning merchant, I want reinstall before final redaction to reconnect my prior workspace without duplicate history.
10. As a privacy-conscious merchant, I want reinstall after completed redaction to start fresh, so that deleted data is not silently restored.

### Catalog and report creation

11. As a merchant, I want to see how many active and published products and variants Market Signal can read before I subscribe or run a report.
12. As a merchant, I want drafts and archived products excluded from report input, so that unpublished catalog work does not appear in results.
13. As a merchant, I want each imported product to retain its Shopify URL, title, variant, price, currency, locale, and observation time where available.
14. As a merchant, I want Shopify catalog facts labeled as authenticated first-party merchant data, so that they are not confused with public crawl results.
15. As a merchant, I want a report preview to show my selected plan, one-report quota impact, comparison target, and catalog coverage before confirmation.
16. As a merchant, I want to choose the existing English or Arabic report locale before confirmation.
17. As a merchant, I want report creation to require an explicit confirmation, so that opening or installing the app cannot start paid work.
18. As a merchant, I want a repeated click, iframe retry, or network retry to create one report and reserve quota once.
19. As a merchant, I want report progress and failures shown as explicit lifecycle and data-quality states instead of an empty success.
20. As a merchant, I want the comparison target to mean saved priced comparisons, not merely products crawled, so that plan value matches the customer-facing result.
21. As a merchant, I want comparisons with missing, zero, non-finite, or unsupported-currency rival prices excluded from accepted report results.
22. As a merchant, I want public rival facts, first-party Shopify facts, inference, estimate, and recommendation labels preserved throughout the report.
23. As a merchant, I want a dispatch failure to release or reconcile the report reservation according to the existing billing rules.

### Reports and sharing

24. As a merchant, I want App Home to list reports owned by my shop, including status, domain, creation time, plan, and comparison count.
25. As a merchant, I want to open an owned report inside Shopify Admin without signing in to the standalone website.
26. As a merchant, I want report and comparison pagination to remain usable on large plans without loading the full result at once.
27. As a merchant, I want an unshared report URL to return not found to unauthenticated and cross-shop visitors.
28. As a merchant, I want to create a share link only through an explicit action.
29. As a merchant, I want sharing confirmation to warn that first-party Shopify catalog facts will be visible to anyone with the link.
30. As a merchant, I want to revoke or rotate a share link immediately.
31. As a merchant, I want shared reports to retain evidence, source, observed-time, market, language, and confidence labels.

### Billing and entitlements

32. As a Shopify merchant, I want to choose a Market Signal plan on Shopify's hosted plan-selection page.
33. As a Shopify merchant, I want Shopify to bill me and handle upgrades, downgrades, cancellation, and billing status.
34. As a merchant, I want Starter, Solo, Growth, and Agency to grant the same product capabilities whether purchased through Shopify or the direct web product.
35. As a merchant, I want an inactive, cancelled, frozen, or otherwise ineligible Shopify subscription to block new quota and credit consumption while preserving allowed read access.
36. As a merchant, I want plan changes reflected before the next report or price-watch confirmation.
37. As a Market Signal operator, I want a workspace to have exactly one billing provider, so that no merchant can be charged by Shopify and Stripe for the same workspace.
38. As a Market Signal operator, I want Stripe Checkout rejected for Shopify-owned workspaces and Shopify subscription attachment rejected for direct web workspaces.

### Price watch and notifications

39. As a merchant, I want to activate an item-level watch from a saved priced comparison in the Products view.
40. As a merchant, I want to activate or manage a whole-rival watch from the Competitors view.
41. As a merchant, I want a watch preview to show eligible targets, reused targets, immediate credit debit, cadence, and projected checks before confirmation.
42. As a merchant, I want one monitoring credit to mean one product price check, matching the existing product rule.
43. As a merchant, I want hourly or daily cadence only when my plan and remaining credits allow it.
44. As a merchant, I want a retried watch confirmation to activate one bounded set and debit the baseline once.
45. As a merchant, I want to disable a watcher immediately and stop future checks.
46. As a merchant, I want in-app notifications for price changes and discounts.
47. As a merchant, I want email notifications when Shopify provides a verified staff email and I opt in.
48. As a merchant without a trusted email available to the app, I want the app to explain that notifications remain in-app instead of sending to a fabricated address.
49. As a merchant, I want price history to show source URL, observed time, previous price, current price, currency, and change direction.

### Privacy, lifecycle, and reliability

50. As a merchant, I want uninstall to delete the usable Admin API token immediately and stop catalog refreshes and watchers.
51. As a merchant, I want Shopify's mandatory privacy requests accepted even though the app requests no customer data.
52. As a merchant, I want final shop redaction to remove the installation, Shopify workspace, Shopify-derived reports, watchers, notifications, and Shopify-only staff identities within the documented window.
53. As a Market Signal operator, I want webhook signatures verified before any state change.
54. As a Market Signal operator, I want replayed webhook deliveries to be idempotent.
55. As a Market Signal operator, I want encrypted offline tokens to remain unreadable in database files and backups without the protected runtime key.
56. As a Market Signal operator, I want Shopify API throttling and partial catalog failures shown as bounded retry or data-quality states rather than uncontrolled retries.
57. As a Market Signal operator, I want app installation, authentication, billing, webhook, report, and watch failures observable without logging secrets or raw tokens.

## Implementation Decisions

### Distribution and application boundary

- Select public distribution in Shopify's Dev Dashboard. This is an irreversible distribution choice and requires Shopify App Store approval.
- Implement the embedded experience at `/shopify/*` inside the existing Market Signal application and immutable VPS image.
- Do not deploy the official React Router template as a second service. Shopify's token-exchange protocol can be implemented by a custom Node frontend, while a second service would create a second deployment boundary and cannot safely share the current container-local SQLite database.
- Use Shopify App Bridge from Shopify's supported delivery mechanism and Shopify's current App Home UI components or Polaris web components. Keep Shopify-specific presentation and protocol code behind a narrow boundary.
- Do not add an OpenAI Sites dependency or fallback. Production remains Trigger.dev plus the Market Signal VPS deployment at `signal.blyzr.com`.

### Authentication and actor mapping

- Every `/shopify/*` data request presents a fresh App Bridge ID token in the `Authorization` header. Browser cookies never authenticate the embedded surface.
- Verify token signature and `exp`, `nbf`, `aud`, `iss`, `dest`, and `sub` claims. The `aud` must equal the Shopify app client ID; `iss` and `dest` must name the same strict `*.myshopify.com` shop; `dest` must match the persisted installation.
- Return `X-Shopify-Retry-Invalid-Session-Request` on eligible stale-token requests so App Bridge can retry once with a fresh ID token.
- Exchange the verified ID token for:
  - an encrypted offline token used for catalog snapshots and background work; and
  - an online token only when staff attribution or verified contact metadata is needed.
- Map `(shop domain, Shopify staff sub)` to an issuer-keyed non-credential account. Keep `providerId = 'shopify'`, `issuer = 'shopify:<shop-domain>'`, and `accountId = <sub>`.
- The current account schema requires a unique non-null email. Until generic principals exist, create a deterministic non-routable `.invalid` sentinel address, keep `emailVerified = 0`, create no credential account, never permit password reset for that identity, and never send mail to it. This preserves existing `user(id)` foreign keys without pretending the sentinel is a real contact address.
- Store a verified `associated_user.email` separately as optional Shopify staff contact metadata. Email notifications use it only when Shopify reports `email_verified = true` and the merchant opts in.
- `shopifyActorContext(request)` returns the same `{ workspaceId, userId }` contract used by existing report and price-watch services.
- Add dynamic frame headers on embedded routes: `Content-Security-Policy: frame-ancestors https://admin.shopify.com https://<shop>.myshopify.com`. Do not emit `X-Frame-Options: DENY` on those routes. Keep strict anti-framing headers on non-embedded sensitive pages.

### Installation, workspace, and token storage

- Add a Shopify installation store keyed by canonical shop domain with Shopify shop GID, workspace ID, encrypted offline access token, refresh token when applicable, expiration, granted scopes, install state, install timestamps, uninstall timestamp, redaction state, token-key version, Admin-reported primary storefront URL, and storefront-state metadata.
- Add `kind = 'shopify'` workspaces with a unique canonical Shopify shop identity. A reinstall cannot create a second active workspace for the same shop.
- Encrypt offline and refresh tokens with authenticated encryption such as AES-256-GCM. Keep the encryption key and rotation version only in protected runtime configuration, never source control, database rows, logs, errors, or deployment artifacts.
- Validate the shop hostname before token exchange or Admin API calls. Reject custom domains, subdomains outside `myshopify.com`, ports, userinfo, paths, and mixed-host `iss`/`dest` values.
- Installation ends at catalog coverage and plan status. It does not call report creation, comparison search, evaluation, or price-watch activation.

### Catalog source

- Add a `shopify-admin` primary-catalog extraction source to the existing product provenance model.
- Use the GraphQL Admin API with `read_products` to retrieve active, published products and variants. Use bounded pagination or Shopify bulk operations when the catalog size crosses a tested threshold.
- Normalize source data into the existing `ProductRecord` contract without erasing Shopify product ID, variant ID, title, handle, canonical URL, variant title, finite positive price, currency, image reference, locale, vendor, product type, tags, observed time, and publication status when available.
- Define the report identity deterministically. Set `report_runs.primary_domain` to the validated host from Shopify `Shop.primaryDomain.url` when Shopify reports a configured public primary domain; otherwise use the canonical `<shop>.myshopify.com` installation domain. This field is identity, display, and rival-discovery context, not evidence that the storefront was publicly crawled.
- Classify the primary storefront as `public`, `password_protected`, `not_configured`, or `unreachable`. A password-protected, storefront-less, or development store does not block report creation because the merchant catalog comes from the authenticated Admin API. Surface the state as a data-quality limitation instead.
- When a public product URL is available, persist it as `ProductRecord.sourceUrl`. Otherwise construct the canonical HTTPS Shopify product path from the validated installation domain and handle solely as a stable product locator, mark it `not_publicly_verified`, do not treat it as public-source evidence, and suppress or disable that link in shared output unless it later passes public verification. Never fabricate availability or price evidence from that locator.
- Rival discovery uses the merchant's authenticated title, description, media-derived metadata when available, vendor, product type, tags, locale, currency, and market context. It does not require the primary storefront homepage to be publicly accessible.
- Label Shopify Admin data as authenticated first-party merchant data with high source confidence. Do not imply that a high-confidence source makes a later rival match high confidence.
- Do not use the existing public Shopify UCP recovery path for the installed shop. UCP remains a public-source fallback for eligible public domains and rivals.
- Snapshot on report preview and revalidate on confirmation if the preview is stale. Do not continuously mirror the entire catalog or subscribe to product-change webhooks in v1.
- Keep catalog-size coverage separate from the plan's comparison target. Customer-facing plan value remains accepted priced comparisons.

### Report engine integration

- Reuse `report-command-service.ts`, `report-query-service.ts`, existing billing reservations, report ownership, share controls, and Trigger.dev jobs.
- Extend the report job contract with an authenticated primary-catalog source reference. The job retrieves the saved snapshot through an internal callback-token-authenticated endpoint; it never receives the Shopify offline token.
- The Shopify adapter supplies the primary catalog. The existing report workflow performs rival discovery, public page verification, price validation, comparison persistence, and terminal accounting.
- Preserve current comparison limits by plan: Starter 20, Solo 50, Growth 500, and Agency 1,000 accepted priced comparisons per report.
- Require preview and confirmation for report creation. Use a durable `commandId` so retries return the recorded result rather than dispatching again.
- Treat catalog retrieval failures, Shopify throttling, empty eligible catalog, dispatch failure, search exhaustion, and comparison shortfall as distinct user-visible states.
- Any shared Trigger contract is deployed and verified Trigger-first, followed by the exact compatible VPS commit.

### Billing and entitlements

- Use Shopify App Pricing for public-app subscriptions. Shopify hosts plan selection and manages billing lifecycle.
- Query current Shopify App Pricing subscription state through the Partner API and persist a bounded local entitlement projection for request-time checks and outage tolerance. Reconcile on plan-return redirects, App Home entry, before every quota- or credit-consuming confirmation, and a scheduled repair sweep.
- Use the Partner API's authoritative `currentBillingCycle.startTime` and `currentBillingCycle.endTime` as the existing billing reservation `period_start` and `period_end`. Parse each timestamp and serialize it with `Date.toISOString()` so the canonical representation is always UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Never derive a period from reconciliation time or assume a 30-day month. Reconciliation of an unchanged subscription must write byte-identical period boundaries and must not reset report or monitoring usage.
- The first release has no free trial. An active plan with a null `currentBillingCycle` grants no paid entitlement and blocks new spending with a recoverable billing-state message; a future trial must define separate period and allowance semantics before launch.
- Shopify App Pricing does not currently emit Billing API subscription-change webhooks, so the app intentionally does not register a fictional `app_subscriptions/update` handler. It detects outside plan changes through the plan-return parameters, App Home entry, pre-confirmation reconciliation, and the scheduled sweep. If the authoritative read fails or the cached projection is stale, fail closed for new spending while preserving access to owned reports.
- Protected runtime configuration includes `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_CLIENT_ID`, `SHOPIFY_PARTNER_CLIENT_SECRET`, `SHOPIFY_APP_GID`, and an explicitly pinned supported Partner API version, in addition to the Shopify app client secret and token-encryption keys. None may appear in source, logs, PRs, task documents, browser payloads, or Trigger job arguments.
- Map Shopify plan handles to the same provider-neutral `ProductPlan` definitions used by Stripe workspaces.
- Refactor `activeWorkspacePlan` into a provider-neutral entitlement arbiter. A workspace's provider is immutable after paid use unless a separately reviewed migration exists.
- Enforce provider exclusivity in persistent storage and command services, not only the UI.
- Do not send report counts or monitoring checks as Shopify usage events in v1 because plans include fixed limits rather than metered overage. If credit top-ups or metered overage are introduced later, define and test App Events separately.
- Preserve read-only access to owned historical reports when a subscription is inactive, while blocking new reports and credit-consuming watch actions according to existing product rules.

### Reports, privacy, and sharing

- Default every Shopify report to private ownership by the shop workspace.
- Embedded report routes authorize through Shopify session tokens and return owned-or-not-found semantics.
- Do not accept public share tokens as embedded authentication and do not turn an embedded session into a reusable public capability.
- Sharing remains a separate explicit action. Confirmation names the report, explains that anyone with the link can view it, and warns when the report contains Shopify Admin-derived facts.
- Shared output keeps first-party, public fact, inference, estimate, recommendation, source, observed-time, market, language, and confidence labels.
- Unshare and rotate actions invalidate prior links immediately.

### Price watch and notifications

- Reuse `price-watch-service.ts` and the existing preview/confirm command pattern.
- Keep item-level watch controls on Products and whole-rival controls on Competitors.
- Watch only persisted rival comparisons with a canonical public product URL and finite positive supported-currency price.
- One monitoring credit remains one product check. Preview shows the exact immediate debit and projected cadence before confirmation.
- Keep in-app notifications for every Shopify workspace. Resolve email delivery through verified Shopify staff contact metadata; never send to `.invalid` sentinel addresses.
- On uninstall, disable all watchers synchronously before acknowledging success. Scheduled tasks must also verify installation state before consuming a credit.

### Webhooks and data lifecycle

- Register and HMAC-verify `app/uninstalled`, `app/scopes_update`, `customers/data_request`, `customers/redact`, and `shop/redact`.
- Record a bounded delivery identifier or payload digest before processing so replayed webhooks are idempotent.
- `app/uninstalled` deletes usable offline and refresh tokens immediately, disables catalog refresh and watchers, and marks the workspace pending redaction.
- `app/scopes_update` refreshes the authoritative granted-scope set and blocks catalog work when `read_products` is absent.
- Customer privacy topics acknowledge and record that Market Signal requests and stores no Shopify customer data.
- `shop/redact` removes the installation, Shopify contact metadata, Shopify workspace data, Admin-derived reports and snapshots, watchers, notifications, share links, and Shopify-only identities within the documented retention window.
- Database backups contain encrypted tokens only. Retention and deletion documentation must state the backup expiry behavior.

### App Home experience

- App Home opens to one concise dashboard:
  - installation and scope health;
  - eligible product and variant coverage;
  - current plan and remaining report/monitoring capacity;
  - a report preview action;
  - recent private reports and their statuses; and
  - recent price changes and discounts.
- Report confirmation shows canonical shop, catalog snapshot time, eligible product count, selected locale, plan, comparison target, report-quota delta, and a clear start action.
- The app never promises that catalog size equals accepted comparisons. It explains that rival evidence must still pass URL, match, market, currency, and finite-price checks.
- Terminal shortfalls show the requested comparison target, accepted result count, rejection reasons, and data-quality limitation rather than silently presenting a lower count as complete.

## Delivery Plan

### Stage 0: Shopify project and review preparation

- Create the app record in Shopify's Dev Dashboard under the production Partner organization.
- Select public distribution only after app URLs, privacy URLs, and ownership are confirmed because distribution cannot later be changed.
- Create a development store with representative active, draft, archived, variant, multilingual, and multi-currency fixtures.
- Configure protected app, Partner API, and encryption credentials locally and in the deployment secret store without copying them into chat, GitHub, or task documents.
- Record App Store requirement and quality-check evidence in the implementation issue.

### Stage 1: Installation, identity, embedded security, and webhooks

- Add the Shopify module boundary, schema, token encryption, actor adapter, App Bridge shell, dynamic frame policy, install lifecycle, mandatory webhooks, and uninstall behavior.
- Prove install/reinstall, no-spend-on-install, cross-shop isolation, invalid token rejection, webhook HMAC, replay protection, and immediate token deletion.

### Stage 2: Authenticated catalog source and Trigger contract

- Add Shopify GraphQL catalog retrieval, normalization, provenance, snapshots, internal snapshot delivery, and Trigger job support.
- Deploy the compatible Trigger contract first, then the exact VPS commit.
- Validate against a real development-store catalog and compare imported records with Shopify Admin. Repeat acceptance with a password-protected development storefront to prove authenticated catalog reporting is independent of public-homepage crawlability and that the limitation is visible.

### Stage 3: Shopify App Pricing and provider-neutral entitlements

- Configure draft Shopify App Pricing plans, Partner API subscription reads, plan-handle mapping, provider exclusivity, local reconciliation, and inactive-state behavior.
- Test every draft plan end to end on a development store before enabling it.

### Stage 4: Report creation, history, views, and sharing

- Add catalog coverage, report preview/confirm, private report history, status polling, comparison pagination, embedded report views, and explicit share/unshare flows.
- Run one explicitly authorized real public-rival comparison report from a development store and verify the exact quota delta.

### Stage 5: Price watch and notifications

- Add item-level and rival-level controls, credit previews, watcher history, in-app notifications, verified-email delivery, and uninstall guards.
- Run one explicitly authorized bounded watch acceptance and verify exact baseline and scheduled credit accounting.

### Stage 6: App Store submission

- Complete listing copy, screenshots, demo video, support contact, privacy policy, data-use declarations, test instructions, reviewer credentials, billing explanation, and deletion behavior.
- Pass local security, accessibility, performance, embedded-app, and Shopify automated quality checks before submission.
- Submit for App Store review only from the exact deployed, verified revision.

Each stage is a focused task, branch, draft PR, strict review, validation, exact-revision deployment, and live verification. Authentication, billing, credentials, privacy, and deployment stages are high risk under repository policy and require two independent fallback reviewers if verified Fable 5 is unavailable.

## Testing Decisions

- Test externally observable behavior and security invariants rather than private implementation details.
- Installation tests prove one Shopify workspace per shop, no report, no watcher, no reservation, and zero credits spent.
- Session-token tests cover missing, malformed, expired, future, wrong-audience, forged-signature, mismatched `iss`/`dest`, foreign-shop, and replayed requests.
- Embedded browser tests run with third-party cookies blocked and verify App Home, report history, and watch controls still work.
- Frame-policy tests prove only the correct Shopify Admin parents can embed `/shopify/*`, while ordinary account and billing pages remain protected from framing.
- Identity tests cover two staff members in one shop, the same human email in two shops, absent or unverified Shopify email, no credential login for Shopify-only identities, and no mail to sentinel addresses.
- Token-storage tests prove authenticated encryption, random nonces, key-version support, tamper rejection, no plaintext secrets in database or logs, and immediate deletion on uninstall.
- Shop validation tests reject malicious hostnames, redirects, userinfo, ports, custom domains, and `iss`/`dest` mismatch before any outbound Admin API call.
- Catalog tests cover active, draft, archived, unpublished, product-with-variants, zero price, compare-at price, missing image, Unicode and Arabic titles, pagination, bulk operation completion, throttling, partial failure, and stable provenance.
- Storefront-identity tests cover a valid custom primary domain, canonical `myshopify.com` fallback, password protection, no configured storefront, unreachable storefront, and development-store behavior. They prove deterministic `primary_domain`, no false public-source claim, safe link suppression, and successful Admin-backed report continuation.
- Real-data acceptance compares a development-store catalog snapshot to Shopify Admin and records the exact product and variant counts.
- Report tests prove Shopify input bypasses public primary crawl while rival discovery and verification remain unchanged; report confirmation is idempotent; comparison limits mean accepted priced comparisons; and empty rival prices are never accepted.
- Trigger compatibility tests prove an old VPS cannot dispatch an unsupported catalog contract and a new VPS works with the deployed Trigger version.
- Billing tests cover all four plan handles, active, pending, cancelled, frozen, expired, upgrade, downgrade, null billing cycle, missing Partner credentials, Partner read outage, stale local projection, and exact product entitlements. Repeated reconciliation of the same subscription must produce byte-identical UTC period boundaries and must not reset or duplicate quota usage.
- Provider tests prove Shopify workspaces cannot open Stripe Checkout, direct web workspaces cannot attach Shopify billing, and no database state admits two active providers.
- Privacy tests prove unshared reports are owned-or-not-found, explicit sharing works, warning copy appears for Admin-derived facts, rotation and revocation invalidate prior links, and cross-shop access remains not found.
- Watch tests cover item and rival activation, exact credit preview, daily and hourly cadence, retries, concurrent confirmation, finite-price eligibility, notification creation, verified-email delivery, no-email fallback, disablement, and uninstall race conditions.
- Webhook tests cover invalid HMAC, constant-time verification, duplicate delivery, out-of-order delivery, missing scope, uninstall, all mandatory privacy topics, reinstall before redaction, and fresh install after redaction.
- Deletion tests prove `shop/redact` removes every Shopify-derived row and capability while preserving unrelated workspaces.
- App Store acceptance uses Shopify's current automated checks and a development-store reviewer flow from install through plan selection, report creation, report viewing, watch activation, uninstall, and privacy webhook handling.
- Paid or credit-consuming acceptance requires explicit authorization and records the exact report quota and monitoring-credit delta. Automated tests use fakes, fixtures, Shopify test mode, and injected services and never start uncontrolled paid comparison work.
- The feature is not called complete until focused tests, full tests, type checks, lint, build, strict review, exact-revision deployment, and live development-store acceptance pass.

## Security and Operational Risks

- Offline Admin API tokens are the highest-value Shopify secret. Encryption key loss makes tokens unusable; key exposure compromises every installed shop. Rotation and backup procedures are launch requirements.
- The single VPS is a temporary single point of failure for install callbacks and mandatory webhooks. Shopify retries help but do not replace uptime monitoring, delivery alerts, and recovery drills.
- A public app increases cross-tenant authorization risk. Shop identity is derived only from verified token claims and the installation row, never query parameters or client-supplied workspace IDs.
- Shopify App Pricing subscription state is external and can be briefly unavailable. Bounded cached entitlement data must fail safely for new spending without hiding owned historical reports.
- Shared reports can intentionally publish merchant catalog facts. Explicit confirmation and source labels are required; automatic or default sharing is forbidden.
- Large catalogs can stress Shopify API budgets and SQLite snapshot writes. Pagination, bulk operations, bounded snapshots, rate-limit handling, and load tests are required before Agency-scale launch.
- Global iframe latency from one VPS region can affect App Store quality scoring. Instrument App Home latency and catalog-preview timing before submission.

## Out of Scope

- Custom distribution for one merchant or one Shopify Plus organization.
- A second React Router service, second database, or independent Shopify report engine.
- A Shopify theme app extension, storefront widget, checkout extension, POS extension, or customer-account extension.
- Customer, order, inventory, discount, theme, checkout, or protected customer data access.
- Writing products, prices, metafields, tags, or any other Shopify store data.
- Automatic report creation on install, catalog update, plan selection, or App Home open.
- Continuous full-catalog mirroring or `products/*` webhooks in v1.
- Linking an existing Market Signal direct-web workspace to a Shopify install in v1.
- Migrating an existing Stripe subscription into Shopify billing.
- Team-role administration beyond Shopify staff identity and shop-level access.
- Free trials, credit top-ups, usage overage, annual plans, negotiated private plans, or different Shopify prices in v1.
- Changing the rival search, matching, evaluation, supported-currency, finite-price, or comparison-acceptance algorithm as part of Shopify integration.
- Publishing reports by default or exposing private reports to Shopify storefront visitors.
- Arabic App Store listing or full embedded UI localization in v1.

## Further Notes

- Shopify states that public distribution can install on multiple stores, requires approval, and uses token exchange for embedded apps. Distribution cannot be changed after selection: https://shopify.dev/docs/apps/launch/distribution
- Shopify documents App Bridge ID tokens and token exchange for custom embedded frontends, including offline and online access tokens: https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange
- Shopify access scopes are explicit merchant permissions; the first release requires only authenticated `read_products`: https://shopify.dev/docs/api/usage/access-scopes
- Shopify requires mandatory privacy/compliance webhook handling for public apps: https://shopify.dev/docs/apps/build/webhooks/subscribe
- Shopify App Pricing hosts plan selection and billing lifecycle. Current subscription state is queried through the Partner API: https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/migrating-to-shopify-app-pricing
- The Partner API `activeSubscription` result supplies the authoritative current billing-cycle timestamps used for local entitlement periods: https://shopify.dev/docs/api/partner/latest/queries/activeSubscription
- Verified Claude Fable 5 (`claude-fable-5`) reviewed the architecture against the current account/workspace schema, billing store, product entitlements, report command/query services, price-watch services, Shopify UCP recovery, and VPS deployment. Verdict: `APPROVE WITH CHANGES`.
- Fable's required changes are incorporated here: one in-process embedded boundary; session-token-only Shopify routes; dynamic frame policy; provider exclusivity; encrypted offline tokens; strict shop validation; mandatory webhook and redaction behavior; explicit spend previews; Trigger-first catalog-contract deployment; and no public UCP substitution for authenticated merchant catalog data.
- Fable's identity follow-up confirmed that existing price-watch records require real `user(id)` rows. The v1 issuer-keyed account plus non-routable `.invalid` sentinel preserves those foreign keys, creates no credential login, and keeps verified contact email separate from authentication identity.
- Fable's exact-PRD follow-up identified three launch blockers that are resolved here: canonical Partner billing-cycle timestamps and credentials, explicit reconciliation without a nonexistent subscription webhook, and deterministic report identity plus protected/storefront-less shop behavior.
- The separate implementation tasks should preserve this PRD's module boundaries and acceptance criteria rather than delivering one large authentication, billing, catalog, UI, and compliance change.

## Acceptance Summary

1. Any eligible merchant can install the public app on a development store and reach an embedded App Home without creating a Market Signal password.
2. Installation requests only `read_products`, creates one Shopify workspace, and spends no report quota or monitoring credits.
3. Shopify session tokens—not browser cookies or query parameters—authorize every embedded read and mutation with cross-shop owned-or-not-found behavior.
4. Market Signal reads an authenticated active/published catalog snapshot with first-party provenance and passes it to the existing Trigger.dev report workflow without exposing the Shopify token.
5. A merchant can preview and confirm one report, then see its private status, accepted priced comparisons, evidence, and data-quality limitations in Shopify Admin.
6. Starter, Solo, Growth, and Agency Shopify plans map to the same 20, 50, 500, and 1,000 comparison targets and existing report/credit limits as direct web plans.
7. A Shopify workspace can never attach Stripe billing, and a direct web workspace can never attach Shopify billing.
8. A merchant can preview, activate, inspect, and disable item-level and rival-level price watches with exact credit accounting and in-app notifications.
9. Reports are private by default and become public only through explicit, revocable sharing with a first-party-data warning.
10. Invalid authentication, webhook replay, uninstall, scope loss, privacy requests, and final redaction fail safely and leave no usable Shopify token or active watcher behind.
11. The exact reviewed Trigger and VPS revisions pass all checks and one explicitly authorized development-store end-to-end acceptance before App Store submission.
