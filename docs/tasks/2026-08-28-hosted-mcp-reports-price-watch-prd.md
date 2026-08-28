# PRD: Hosted MCP for reports and price-watch control

## Problem Statement

Market Signal customers currently have to use the web application to submit a domain, wait for a report, retrieve comparison data, and manage price watches. Customers increasingly work through AI assistants that support the Model Context Protocol (MCP), but Market Signal has no safe machine-facing interface for those workflows.

Simply exposing the browser APIs would be unsafe and incomplete. Those APIs use cookie sessions and same-origin mutation protection, reports are private to an owning workspace, report creation consumes plan quota, and price-watch activation consumes monitoring credits. An assistant must not be able to spend quota accidentally, see another workspace's data, bypass report privacy, replay a mutation, or turn a shared report link into account access.

Customers need a standards-based MCP connection that lets an authorized assistant:

- add a domain and start a report;
- list and retrieve only the customer's reports and comparison data;
- inspect report progress without holding a long-running connection;
- activate monitoring for one comparison or all eligible products from one rival;
- understand the exact credit effect before activating or changing a watch;
- list, update, disable, resume, and delete price watches; and
- retrieve price history and price-watch notifications.

The first release must reuse the same billing, ownership, report, and price-watch rules as the web application so that the two interfaces cannot disagree.

## Solution

Provide a hosted, remote Market Signal MCP endpoint for standards-compliant AI clients. A customer connects through browser-based OAuth authorization and grants narrowly scoped access to their personal Market Signal workspace. The MCP resolves that authorization to the same user, workspace, subscription, quota, and monitoring-credit state used by the web application.

The MCP exposes tools rather than a second application-specific REST API. Read tools let an assistant inspect account capacity, list reports, poll report status, page through verified comparisons, list watchers, retrieve watcher history, and retrieve notifications. Report creation and any price-watch operation that can spend quota or monitoring credits use a mandatory preview/confirm sequence. Preview returns the canonical action, exact current impact, and a short-lived confirmation. Confirm executes that exact action once and safely replays its recorded outcome if the client retries.

Reports remain private and workspace-owned. Shared report capabilities and public links are not accepted as MCP credentials. Report creation remains asynchronous: confirmation returns a queued report reference, and the client polls report status using a server-provided pacing hint. Price watches support both an individual comparison target and a whole-rival target, with daily or hourly cadence where allowed by the existing product rules.

Delivery is staged so the authentication upgrade, shared domain-service extraction, OAuth surface, read-only MCP, and credit-consuming tools can each be reviewed, tested, deployed, and rolled back independently.

## User Stories

1. As a Market Signal customer, I want to connect my AI assistant through a browser login, so that I do not have to copy credentials into the assistant.
2. As a Market Signal customer, I want to see the requested permissions before connecting, so that I understand what the assistant can read or change.
3. As a Market Signal customer, I want report-reading and report-creation permissions to be separate, so that I can grant read-only report access.
4. As a Market Signal customer, I want price-watch reading and price-watch control permissions to be separate, so that I can inspect monitoring without allowing changes.
5. As a Market Signal customer, I want permission descriptions to state when an action can consume quota or credits, so that consent is informed.
6. As a Market Signal customer, I want to revoke a connected MCP client, so that its access stops without changing my Market Signal password.
7. As a Market Signal customer, I want revoked access to fail on the next MCP request, so that revocation has an immediate security effect.
8. As a Market Signal customer, I want an assistant to show my active plan and subscription state, so that I know whether report and monitoring actions are available.
9. As a Market Signal customer, I want an assistant to show my report usage and limit, so that I can plan new reports.
10. As a Market Signal customer, I want an assistant to show my monitoring-credit usage and limit, so that I can plan price watches.
11. As a Market Signal customer, I want account-status output limited to the permissions I granted, so that a narrowly authorized client does not receive unrelated billing data.
12. As a Market Signal customer, I want to submit either a bare domain or a normal website URL, so that report creation is convenient.
13. As a Market Signal customer, I want Market Signal to canonicalize and validate the submitted domain before spending quota, so that malformed input cannot consume a report.
14. As a bilingual customer, I want to choose English or Arabic report locale, so that the report follows my preferred presentation language.
15. As a Market Signal customer, I want to preview report creation before confirming it, so that I can see the canonical domain and exact report-quota impact.
16. As a Market Signal customer, I want report preview to fail before confirmation when my subscription or quota is insufficient, so that no partial run is created.
17. As a Market Signal customer, I want report confirmation to create only one report even if my assistant retries, so that one request cannot consume quota twice.
18. As a Market Signal customer, I want report confirmation to return a private report reference and status, so that my assistant can continue the workflow.
19. As a Market Signal customer, I want a dispatch failure to release any report reservation according to the existing billing rules, so that failed infrastructure does not strand quota.
20. As a Market Signal customer, I want to list my recent reports with bounded pagination, so that I can find prior work without retrieving every report at once.
21. As a Market Signal customer, I want report lists to contain only reports owned by my workspace, so that customer data remains isolated.
22. As a Market Signal customer, I want to retrieve a compact report summary and current lifecycle status, so that an assistant can explain where the run stands.
23. As a Market Signal customer, I want non-terminal reports to provide a recommended polling interval, so that assistants do not overload the service.
24. As a Market Signal customer, I want terminal failures and data-quality limitations returned as explicit states, so that an assistant does not invent missing results.
25. As a Market Signal customer, I want to page through authoritative saved comparisons, so that large reports remain usable through MCP.
26. As a Market Signal customer, I want each comparison to include the primary product, rival product, prices, currency, source URLs, and evidence metadata available in the report, so that the result is auditable.
27. As a Market Signal customer, I want observed facts, inferences, estimates, and recommendations to remain visibly distinct, so that an assistant cannot present inference as fact.
28. As a Market Signal customer, I want evidence to retain observed time, region, language, confidence, and source URL where applicable, so that I can judge freshness and relevance.
29. As a Market Signal customer, I want an unknown or unavailable comparison store to return an explicit error rather than an empty success, so that incomplete data is not misleading.
30. As a Market Signal customer, I want a nonexistent or unauthorized report to look the same to the MCP client, so that report identifiers cannot be enumerated across workspaces.
31. As a Market Signal customer, I want to list my active, disabled, and relevant price watchers, so that I can understand what is being monitored.
32. As a Market Signal customer, I want to retrieve a watcher's bounded price history, so that an assistant can summarize changes over time.
33. As a Market Signal customer, I want to retrieve price-watch notifications, so that an assistant can tell me about price changes and discounts.
34. As a Market Signal customer, I want notification retrieval to be read-only in the first release, so that an assistant cannot silently clear notifications.
35. As a Market Signal customer, I want to watch one persisted comparison from one of my reports, so that I can follow a specific rival product.
36. As a Market Signal customer, I want to watch all currently eligible products for one rival in my report, so that I can monitor a competitor without activating every item manually.
37. As a Market Signal customer, I want whole-rival activation to describe the eligible target snapshot used at confirmation time, so that I know what the bulk action covers.
38. As a Market Signal customer, I want a watch target to require a valid first-party product URL and a finite positive supported-currency price, so that credits are not spent on unusable items.
39. As a Market Signal customer, I want to choose daily or hourly monitoring when available, so that monitoring frequency matches the importance of the item.
40. As a Market Signal customer, I want activation preview to show eligible, ineligible, new, and reused watchers, so that I understand the action before confirming.
41. As a Market Signal customer, I want activation preview to show the exact baseline credits and projected daily and monthly checks, so that I understand immediate and ongoing cost.
42. As a Market Signal customer, I want activation confirmation to fail safely if eligibility, price, subscription, or credit impact changes after preview, so that a stale confirmation cannot approve a different expense.
43. As a Market Signal customer, I want an already-active identical watcher to be reused without a new baseline charge, so that repeated requests are not wasteful.
44. As a Market Signal customer, I want bulk rival activation to respect the existing server-side safety bound, so that one request cannot activate an unbounded number of watchers.
45. As a Market Signal customer, I want to preview resuming a watcher, so that I can see whether a new baseline credit will be required.
46. As a Market Signal customer, I want to preview a cadence increase, so that I understand the higher projected check rate before confirming.
47. As a Market Signal customer, I want a cadence reduction to preserve existing product rules and accounting, so that lowering frequency is safe and predictable.
48. As a Market Signal customer, I want to disable a watcher immediately without a confirmation step, so that I can stop future monitoring quickly.
49. As a Market Signal customer, I want disabling a watcher to release future reservations according to existing rules, so that unused monitoring capacity becomes available.
50. As a Market Signal customer, I want deleting a watcher to require explicit preview and confirmation, so that history is not removed accidentally.
51. As a Market Signal customer, I want deletion preview to explain that consumed credits remain consumed and watcher history will be removed, so that the destructive effect is clear.
52. As a Market Signal customer, I want mutation confirmations to expire quickly, so that an old assistant conversation cannot spend quota later.
53. As a Market Signal customer, I want confirmation to be bound to my user, workspace, connected client, action, and canonical input, so that a token cannot authorize a different action.
54. As a Market Signal customer, I want a retried confirmation to return the recorded result without re-executing, so that network retries are safe.
55. As a Market Signal customer, I want clear stable error codes for subscription, quota, credit, authorization, validation, confirmation, and data-quality failures, so that assistants can respond reliably.
56. As a Market Signal customer, I want rate limits to protect my workspace from a malfunctioning assistant, so that polling or retries cannot degrade my account.
57. As a Market Signal customer, I want rate limits applied independently per connected client, so that one client does not consume another client's allowance.
58. As a privacy-conscious customer, I want MCP authentication to ignore browser cookies, so that a browser session cannot accidentally authorize a machine request.
59. As a privacy-conscious customer, I want access tokens accepted only for the exact Market Signal MCP resource, so that a token issued for another service cannot be replayed.
60. As a privacy-conscious customer, I want shared-report tokens structurally excluded from MCP, so that sharing one report cannot grant account-level access.
61. As a privacy-conscious customer, I want MCP outputs to omit internal workspace, billing-reservation, authentication, and secret fields, so that assistants receive only customer-facing data.
62. As a Market Signal operator, I want every MCP action to record limited audit metadata, so that abuse and billing disputes can be investigated without storing prompts or secrets.
63. As a Market Signal operator, I want read requests to create at most one coarse audit write, so that polling does not create excessive database contention.
64. As a Market Signal operator, I want report and price-watch commands to call shared domain services directly, so that MCP and browser behavior cannot drift.
65. As a Market Signal operator, I want the MCP endpoint disabled when hosted billing or account authentication is disabled, so that legacy and self-hosted modes do not expose a broken authorization surface.
66. As a Market Signal operator, I want authentication upgrades deployed independently from MCP tools, so that session regressions can be detected and rolled back first.
67. As a Market Signal operator, I want read-only MCP tools to soak before mutation tools launch, so that protocol and authorization behavior can be validated without spending customer quota.
68. As a Market Signal operator, I want a real standards-compliant MCP client to pass an end-to-end acceptance test, so that the feature is proven outside unit fixtures.
69. As a Market Signal operator, I want paid real-domain acceptance work to require explicit authorization, so that testing cannot unexpectedly consume report quota or monitoring credits.
70. As a self-hosted operator, I want the hosted MCP dependency and its exclusions documented, so that the open-source deployment does not imply unsupported OAuth or billing behavior.

## Implementation Decisions

### Product and protocol boundary

- The first release is one hosted remote MCP endpoint at `https://signal.blyzr.com/mcp`.
- The endpoint uses stateless Streamable HTTP and JSON responses. Local stdio and legacy SSE transports are not included.
- The MCP exposes tools only. Resources and resource templates are deferred because all required reads are parameterized, paginated, and authorization-sensitive.
- The endpoint exists only when hosted billing and account authentication are both configured. Other deployments return not found.
- MCP handlers call shared domain services directly. They never call Market Signal's browser HTTP routes and never bypass browser same-origin protection.
- The MCP protocol adapter remains thin; business rules stay in reusable report, billing, authorization, and price-watch services.

### Authentication and authorization

- Upgrade Better Auth from 1.6.26 to a stable 1.7-compatible release in an isolated change before adding MCP plugins or behavior.
- Verify the exact stable package identities and compatibility for the Better Auth MCP and client-metadata integrations before implementation. Beta-only packages are not accepted for the production plan without a separate decision.
- Use OAuth 2.1 authorization code flow with PKCE, browser consent, rotating refresh tokens, revocation, and a connected-apps management surface.
- Use bearer tokens from the `Authorization` header only. Valid browser cookies never authenticate an MCP request.
- Require the Market Signal MCP resource indicator during authorization and require an exact matching token audience on every MCP call.
- Prefer revocable opaque access tokens in the first release, with access-token lifetime no longer than one hour. A JWT/JWKS design requires a separate reason to accept delayed revocation.
- Stage 3 must produce and implement a reviewed client-registration decision before read-only MCP work begins. The decision must enumerate every supported path, including whether Client ID Metadata Documents and dynamic client registration are supported, and document compatibility with the target Claude, Codex, and standards-compliant test clients.
- Authorization and consent endpoints use state validation, same-site secure cookies, CSRF protection, frame-ancestor or equivalent clickjacking protection, and explicit user confirmation of the requested client, resource, scopes, and spending implications.
- Resolve each token to the existing Market Signal user and personal workspace context. Workspace ownership remains the authorization boundary.
- Use four scopes: `reports:read`, `reports:create`, `price_watch:read`, and `price_watch:write`.
- Price-watch notifications are included under `price_watch:read`; a separate notification scope is deferred until another notification domain exists.
- Consent language states that report creation consumes plan report quota and price-watch writes can consume monitoring credits.
- Shared-report capabilities are unreachable from MCP. No MCP tool accepts a share token, and the MCP service layer does not use shared-report resolution.

### Read tool contract

- `account_status` is callable with any Market Signal MCP scope and filters fields by domain: `reports:read` or `reports:create` reveals the active-plan and subscription state needed for report availability plus report usage and limit; `price_watch:read` or `price_watch:write` reveals the state needed for monitoring availability plus monitoring-credit usage and limit. A client granted scopes from only one domain never receives the other domain's usage fields.
- `reports_list` returns a bounded page of workspace-owned report summaries. The initial limit range is 1 through 50, with an opaque continuation cursor if more results exist.
- `report_get` accepts a report public identifier and returns a compact customer-safe report snapshot, lifecycle status, terminal error or limitation state, private report URL, and `pollAfterSeconds` while non-terminal. The private URL is an ordinary login-required web-app URL with no embedded bearer, share, session, or other capability token.
- `report_matches_list` accepts a report public identifier, opaque cursor, and bounded page size. It returns authoritative saved comparison records and the next cursor.
- `price_watch_list` returns watchers owned by the current workspace and current monitoring usage.
- `price_watch_history` accepts an owned watcher identifier and a bounded limit from 1 through 500.
- `notifications_list` returns bounded price-watch notifications and is read-only in the first release.
- Unauthorized and nonexistent report or watcher identifiers both return `not-found` to prevent cross-workspace enumeration.
- Report outputs use the existing customer-safe redaction boundary and never expose workspace identifiers, billing reservation identifiers, internal authentication fields, or secrets.

### Report creation contract

- `report_create_preview` accepts a domain or website URL and optional English or Arabic locale. It returns the canonical domain, validated locale, current usage, an impact of one report, a confirmation token, and expiration.
- Preview performs all deterministic validation possible without reserving quota or creating a report.
- `report_create_confirm` accepts only the confirmation token. It reserves report quota, creates one queued private report, and dispatches the report job through the shared report-creation service.
- Confirmation returns the queued report public identifier, status, a login-required private URL containing no embedded credential or capability, report expiration when applicable, updated usage, and whether the response is a replay.
- A stable command identifier connects confirmation, report creation, billing reservation, and dispatch. Duplicate delivery cannot create a second report, reserve quota twice, or dispatch an independently billable duplicate run.
- Dispatch failure follows existing server-owned reservation-release behavior and returns a stable failure result. Crash recovery must reconcile the stable command and report identifier rather than repeat report creation.
- Report creation remains asynchronous. Clients poll `report_get`; the MCP Tasks extension is not required in the first release.

### Price-watch contract

- Price-watch activation uses an explicit target choice: one persisted report match, or all currently eligible products for one rival domain in the report.
- `price_watch_preview` accepts an owned report identifier, explicit target, and daily or hourly cadence. It returns target eligibility, new and reused watcher counts, baseline credits, projected daily and monthly checks, current usage, confirmation token, and expiration.
- Whole-rival preview and confirmation use a bounded snapshot of eligible targets. If the live eligible set or credit impact changes before confirmation, confirmation fails with `confirmation-impact-changed` and requires a fresh preview.
- `price_watch_confirm` activates the previewed target set through the existing server-owned subscription, URL, price, currency, credit, and bulk-bound rules.
- `price_watch_update_preview` and `price_watch_update_confirm` cover resuming a watcher and every cadence change. A cadence reduction still uses preview and confirmation, reports zero immediate debit when applicable, and shows the lower projected check rate before applying it.
- `price_watch_disable` is direct and reversible because it stops future work and releases future reservations under existing rules.
- `price_watch_delete_preview` and `price_watch_delete_confirm` protect permanent deletion. Preview states that stored history is removed and consumed debits remain charged.
- Reusing an equivalent active watcher does not reserve another baseline credit.

### Confirmation and idempotency

- Every credit- or quota-consuming preview issues a cryptographically random token with at least 256 bits of entropy and a five-minute lifetime. The raw token is returned once; only its hash is stored.
- A confirmation intent is bound to user, workspace, OAuth client, tool, canonical-input hash, calculated impact, creation time, expiration, state, durable command identifier, and customer-safe recorded outcome. Its state machine is `ready`, `in_progress`, `succeeded`, or `failed`.
- Confirmation atomically claims one unexpired `ready` intent, records its durable command identifier, and moves it to `in_progress` before domain execution. A `succeeded` or `failed` intent returns its recorded terminal result with `replayed: true` and does not execute again.
- A retry of an `in_progress` intent never starts a second command. It first reconciles the durable command against report or price-watch state; if work is still active it returns `confirmation-in-progress` with safe retry guidance, and recovery must eventually record one terminal success or failure. A customer is never required to retry with a new token merely because the server crashed after claiming the original intent.
- Confirmation re-derives live eligibility and impact. For report creation, the material impact is exactly one report; current usage and plan limits are rechecked, but a changed usage snapshot alone is not a mismatch while one report remains eligible. For price-watch actions, the eligible target set, new/reused watcher counts, baseline debit, cadence, and projected checks are material. Any material mismatch fails closed with `confirmation-impact-changed` rather than spending a different amount.
- Confirmation tokens cannot be used to change inputs. The confirm tools accept the token only.
- Tool-level idempotency is defined as exactly-once command acceptance with replay-safe retrieval of the recorded outcome. Report and price-watch commands both use the confirmation intent's durable command identity; external report dispatch additionally uses the stable command/report identity so crash recovery cannot produce duplicate customer work.

### Stable errors and data truth

- Reuse existing customer-facing codes where applicable, including subscription, quota, credit, invalid-domain, watcher, not-found, and facts-unavailable failures.
- Add MCP-layer codes for insufficient scope, invalid or revoked token, wrong resource audience, rate limiting, expired confirmation, confirmation mismatch, changed confirmation impact, and confirmation still in progress.
- Every failure returns a concise safe explanation and enough structured context for the client to recover without exposing internal stack traces.
- Material evidence retains source URL, observed time, claim type, confidence, region, and language where present.
- Public-source facts, inferences, estimates, and recommendations remain explicitly differentiated.
- Access failures, incomplete reports, and missing facts are explicit data-quality states rather than empty successes.

### Deep modules and ownership

- An MCP transport adapter owns protocol parsing, tool discovery, headers, and response envelopes but no product rules.
- An MCP authentication module owns bearer-token verification, audience enforcement, revocation, scope extraction, and conversion to the existing account/workspace context.
- A tool registry owns tool names, required scopes, input validation, handler dispatch, and dependency injection for tests.
- A confirmation-intent module owns issuance, hashing, expiration, atomic claim, impact revalidation, outcome recording, and replay.
- A report-creation command service owns canonical validation, quota reservation, report creation, durable command identity, dispatch, telemetry, and release or recovery behavior. Both browser and MCP creation paths call it.
- Report query services own workspace-authorized listing, compact report retrieval, customer-safe redaction, terminal accounting, and paginated comparisons.
- Price-watch query and command services own previews, eligibility, activation, updates, disablement, deletion, history, notifications, and usage. Browser and MCP paths call the same services.
- A rate-limit module owns durable coarse counters keyed by workspace, connected client, tool class, and window.
- An audit module records timestamp, user, workspace, client, scope, tool, customer object identifiers, quota delta, and result code. It never stores access tokens, confirmation tokens, prompts, secrets, or raw request bodies.

### Operational limits

- Apply separate limits to read polling, report creation, mutation previews, and confirmed price-watch mutations. Limits are keyed by workspace and connected client. Preview issuance has a bounded active-intent count per client/workspace/tool, expired intents are cleaned up, and preview spam cannot grow the intent store without bound.
- `report_get` supplies a polling hint, and production acceptance measures sustained polling against the current SQLite write model.
- Read calls perform no business mutation except existing terminal-accounting reconciliation and at most one coarse audit write.
- The first release targets the existing single-workspace account model. Future organization and workspace selection must not be inferred in v1.

### Delivery sequence

1. Upgrade Better Auth alone, prove no unintended schema or session behavior change, deploy, and retain a rollback path.
2. Extract and deploy behavior-preserving shared report-creation and price-watch-preview services while browser APIs remain functionally unchanged. If a shared Trigger.dev contract changes, deploy and verify the compatible Trigger tasks before the web application.
3. Decide and document the supported OAuth client-registration paths, then add authorization-server/resource-server support, consent, revocation, protected-resource metadata, connected-app management, CSRF and clickjacking defenses, and security tests.
4. Add the stateless MCP endpoint and read-only tools, then soak them with real clients before enabling writes.
5. Add confirmation intents and mutation tools, then perform explicitly authorized real-domain and real-credit acceptance.

Each stage is a focused task and pull request. A dependent stage starts only after the prior stage is reviewed, deployed, and verified.

## Testing Decisions

- Tests assert externally observable behavior and security invariants rather than private implementation structure.
- Preserve and extend the repository's existing dependency-injected route/service test style so billing, dispatch, time, token, and storage behavior can be controlled without paid work.
- The isolated Better Auth upgrade must pass the full existing suite and prove zero unintended changes to existing authentication tables, successful sign-in, session continuity, personal-workspace provisioning and repair, logout, and rollback on a production-like database copy.
- Authentication tests cover missing, malformed, expired, revoked, and wrong-audience bearer tokens; cookie-only requests; resource-indicator enforcement; refresh rotation; revocation; state and CSRF validation; clickjacking headers; consent detail; and each client-registration path selected in Stage 3.
- A complete scope matrix tests every tool against every relevant scope combination. Only the documented scope authorizes each tool.
- Authorization tests prove cross-workspace report and watcher identifiers return not found, legacy-public records cannot be reached, shared-report capabilities are rejected, serialized outputs contain no internal identifiers or tokens, and every returned private report URL is login-required and credential-free.
- Report-preview tests cover URL normalization, invalid domains, locale validation, inactive subscriptions, quota boundaries, and no quota reservation during preview.
- Report-confirm tests cover successful creation, duplicate confirmation, concurrent confirmation, changed usage with unchanged one-report impact, newly insufficient quota, dispatch failure, crashes before and after domain execution, `in_progress` reconciliation, quota release, terminal-outcome replay, and proof that the report command and domain service execute once.
- Report polling tests cover queued, running, complete, stopped, failed, interrupted, and facts-unavailable states plus the recommended poll interval.
- Report comparison tests cover stable pagination, cursor validation, page bounds, authoritative-only output, source/evidence metadata, and no cross-report leakage.
- Price-watch preview tests cover individual and whole-rival targets, unsupported currency, missing or non-positive price, invalid URL, mixed eligibility, bulk safety bounds, reuse, baseline-credit calculation, and hourly/daily projections.
- Price-watch confirmation tests cover exact impact, changed impact, insufficient credits, expiration, concurrent confirmation, crashes before and after domain execution, `in_progress` reconciliation, terminal stored-outcome replay, no duplicate baseline debit, and no activation outside the previewed bounded target set.
- Watch-update tests cover resume, cadence increase, cadence reduction, disablement, reservation release, and ownership.
- Watch-deletion tests cover required confirmation, permanent history deletion, preserved consumed debits, replay, and cross-workspace rejection.
- Notification tests prove retrieval is bounded and read-only.
- Rate-limit tests prove independent workspace/client limits, separate read, preview, and confirmed-write classes, bounded active intents and expiry cleanup, recovery after a window, and safe retry metadata.
- Audit tests prove required metadata is recorded while tokens, prompts, secrets, and raw bodies are absent.
- Load tests exercise multiple clients polling long-running reports and issuing bounded previews against the current SQLite deployment and verify acceptable latency, lock contention, audit-write volume, rate-limit-counter write volume, and confirmation-intent cleanup.
- Protocol conformance is tested with the official MCP Inspector or equivalent standards-compliant client before launch.
- End-to-end acceptance uses a real connected account and real MCP client to authorize, list reports, preview and confirm one report, poll it to a terminal state, retrieve comparisons, preview and activate one eligible price watch, inspect it, and disable it.
- Paid end-to-end acceptance is never run without explicit authorization for the report quota and monitoring credit it will consume. The task records the real domain, exact quota/credit delta, result, and cleanup state.
- Production acceptance verifies the exact reviewed revision, OAuth metadata, consent, revocation on the next request, endpoint health, private ownership, and no browser-flow regression.
- The feature is not called complete until focused tests, full tests, build, lint, typecheck, strict review, deployment, and live MCP-client acceptance all pass.

## Out of Scope

- Local stdio MCP servers.
- Personal API keys, static bearer keys, or copied browser cookies.
- Legacy SSE transport.
- MCP Tasks extension integration; v1 uses explicit polling.
- MCP resources and resource templates.
- Public or anonymously accessible MCP report data.
- Accepting report-sharing tokens through MCP.
- Creating, revoking, or publishing shared report links through MCP.
- Marking notifications read, deleting notifications, or managing email notification preferences.
- Push streaming, webhooks, or server-initiated MCP notifications for report completion or price changes.
- New report plans, new monitoring-credit plans, credit purchasing, or changes to existing billing prices.
- Changes to crawler, search, comparison, evaluation, price eligibility, currency support, monitoring scheduler, or notification-generation algorithms.
- Organization workspaces, workspace switching, team role administration, or delegated service accounts.
- Administrative tools for inspecting other customers.
- Open-source hosted OAuth setup and local MCP packaging; v1 is explicitly a hosted Market Signal feature.
- A generic public REST API or third-party SDK.

## Further Notes

- Tracking issue: [#201 — PRD: Hosted MCP for reports and price-watch control](https://github.com/BlyzrHQ/market-signal/issues/201).
- The intended customer is a signed-in Market Signal plan holder connecting Claude, Codex, or another standards-compliant remote MCP client to their own account.
- The product owner approved both item-level and whole-rival price-watch control, OAuth-only v1 authentication, private workspace data, and preview/confirm protection before credit or quota use.
- Verified Fable 5 reviewed the proposed architecture against the current report, authentication, billing, and price-watch implementation. It judged the core architecture sound and required four hardenings reflected here: isolate the Better Auth upgrade; verify the exact stable Better Auth MCP package set; test bearer-header-only exact-audience authentication as an invariant; and define confirmation as exactly-once command acceptance with recorded-outcome replay and stable dispatch identity.
- Fable also recommended shipping read-only tools before mutation tools, folding notifications into `price_watch:read`, excluding MCP resources in v1, and keeping browser and MCP entry points on the same deep domain services.
- Verified Fable 5 then reviewed the exact PRD, identified no P0 blockers, and returned `FABLE_MCP_PRD_PASS`. Its P1 and P2 clarifications were incorporated and re-reviewed; the final follow-up found no remaining P0 or P1 blockers and again returned `FABLE_MCP_PRD_PASS`.
- The MCP authorization design follows the current MCP authorization model in which the MCP server is an OAuth resource server, publishes protected-resource metadata, and accepts resource-bound bearer tokens.
- The endpoint and tool schemas must be versioned compatibly so additive fields do not break clients and breaking changes require a new documented contract.
- The implementation issue should be decomposed into the five sequential delivery stages above rather than delivered as one high-risk authentication-and-billing pull request.

## Acceptance Summary

1. A standards-compliant remote MCP client can connect to `https://signal.blyzr.com/mcp` through browser OAuth with PKCE and explicit scopes.
2. Revoked, expired, cookie-only, and wrong-audience access fails closed.
3. The client can inspect account capacity, list owned reports, poll one report, and page authoritative comparisons without accessing shared or cross-workspace data.
4. The client can preview and safely confirm one new domain report without duplicate quota use under retries or concurrency.
5. The client can preview and safely confirm both one-match and whole-rival price watches with exact baseline and projected credit impact.
6. The client can list watchers, retrieve history and notifications, preview and confirm resume/cadence changes, disable immediately, and preview/confirm permanent deletion.
7. Browser and MCP workflows use the same report and price-watch domain services and produce equivalent billing, authorization, and eligibility outcomes.
8. Outputs preserve Market Signal's public-fact, inference, estimate, recommendation, provenance, market, and data-quality boundaries.
9. No tool logs or returns credentials, confirmation tokens after issuance, prompts, raw request bodies, or internal authorization and billing identifiers.
10. The five staged changes pass their individual gates, and one explicitly authorized real-domain end-to-end run passes through a real MCP client on the exact deployed revision.
