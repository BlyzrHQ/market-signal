# Hosted MCP read tools

## Goal

Ship the authenticated, stateless Market Signal MCP endpoint and its first owner-scoped read tools so a connected client can retrieve private reports, authoritative comparisons, price watches, watch history, and price-change notifications.

## Scope

- Mount a POST-only `https://signal.blyzr.com/mcp` endpoint with the official MCP 2.0 server package in strict modern-protocol mode.
- Verify every bearer token cryptographically against the Better Auth Ed25519 key set, require the exact MCP resource audience, and re-check the live OAuth client, session, consent, and refresh-token grant before dispatch.
- Reject cookie-only authentication, invalid Host or Origin values, oversized bodies, unsupported methods, legacy MCP traffic, expired or revoked grants, and wrong-audience tokens.
- Register report tools only for `reports:read` and price-watch tools only for `price_watch:read`.
- Reuse the existing workspace-bound report and price-watch services. Shared-report tokens and legacy public records remain unreachable.
- Return bounded report and comparison pages plus customer-safe, credential-free private report links.

## Tools

- `reports_list`
- `report_get`
- `report_matches_list`
- `price_watch_list`
- `price_watch_history`
- `notifications_list`

## Out of scope

- Report creation, price-watch activation or mutation, confirmation intents, or any quota/credit consumption.
- MCP resources, prompts, subscriptions, legacy SSE, local stdio packaging, or public report access.
- Changes to crawling, matching, evaluation, billing prices, or monitoring schedules.

## Acceptance

- Cryptographic and live-grant tests cover missing, malformed, expired, wrong-audience, revoked, and insufficient-scope tokens.
- Tool discovery is scope-filtered, and every object lookup is workspace-owned with cross-workspace identifiers returning `not-found`.
- Request validation covers Host, optional Origin, content type, body size, POST-only behavior, and strict rejection of legacy MCP requests.
- Focused tests, full typecheck/build/test, lint, strict review, exact deployment, and production endpoint smoke checks pass.

## Validation

- `npm test`: PASS (1,225 tests, 0 failures) before the isolated wrong-audience assertion; the updated OAuth test also passes independently.
- `npm run typecheck`: PASS.
- `npm run lint`: PASS with the pre-existing `no-img-element` warning in `app/components/product-design-lab.tsx`.
- `npm run build:vps`: PASS; the production route manifest includes `lambda /mcp` and retains the VPS dependency assertions.
- Built-server smoke: `GET /mcp` returns `405` with `Allow: POST`; unauthenticated `POST /mcp` returns `401` with OAuth protected-resource metadata and no-store headers.
- No report creation, price check, quota consumption, or paid API call was performed during validation.

## Review

- Verified Claude Fable 5 reviewed exact head `ccfdbade25cab9b92b9f256f525981b5e4da69b0` and returned `PASS` with no blocker, high, or medium findings.
- Three non-blocking hardening notes were incorporated: raw-row pagination continuation, cheap request validation before database-backed authorization, and safe operation/error-class diagnostics without logging messages or customer data.
- Final exact-head re-review is required after the hardening commit.

## References

- Parent PRD: `docs/tasks/2026-08-28-hosted-mcp-reports-price-watch-prd.md`
- OAuth implementation: `docs/tasks/2026-08-28-mcp-oauth.md`
- Shared services: `docs/tasks/2026-08-28-mcp-shared-services.md`
- Tracking issue: https://github.com/BlyzrHQ/market-signal/issues/201
