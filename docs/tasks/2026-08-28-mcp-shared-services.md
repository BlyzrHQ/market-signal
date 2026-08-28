# MCP shared report and price-watch services

## Goal

Extract transport-independent report creation and price-watch command/query services so the existing browser APIs and the upcoming hosted MCP use one ownership, billing, quota, credit, eligibility, dispatch, and storage implementation.

## Scope

- Move report reservation, durable run creation, Trigger dispatch, dispatch telemetry, and reservation release into a customer-safe command service.
- Add workspace-bound report query helpers for owned report summaries, compact report retrieval, and authoritative match pagination.
- Move price-watch listing, activation, history, update, disable, and deletion database lifecycles into workspace-bound services.
- Keep browser request parsing, cookie authorization, same-origin mutation protection, HTTP status mapping, and shared-report behavior in the existing routes.
- Preserve all current route payloads and status codes.
- Add direct service tests proving workspace isolation and equivalent browser behavior.

## Out of scope

- OAuth, consent, connected clients, MCP protocol handling, scopes, or bearer-token verification.
- Preview/confirm intents, durable command replay, MCP tools, or new browser UI.
- Changes to plans, report limits, price-watch credits, eligibility, crawling, matching, or Trigger task contracts.

## Acceptance

- Browser report creation and price-watch behavior remains identical and all route tests pass; source-location assertions are updated to follow moved ownership.
- The shared report command service releases reservations on every pre-dispatch or dispatch failure and leaves a successful reservation pending for terminal settlement.
- Workspace query services return only owned, unexpired private reports and watchers; unknown and cross-workspace identifiers are indistinguishable.
- No service accepts a browser cookie, share token, or client-supplied plan/credit override.
- Full typecheck, build, lint, tests, strict review, exact deployment, and live browser/API regression checks pass.

## References

- Parent PRD: `docs/tasks/2026-08-28-hosted-mcp-reports-price-watch-prd.md`
- Tracking issue: https://github.com/BlyzrHQ/market-signal/issues/201

## Implementation

- `report-command-service.ts` now owns report quota reservation, server-resolved entitlement, durable creation, Trigger dispatch, dispatch telemetry, and exact reservation release on failure.
- `report-query-service.ts` now owns private workspace report listing, retrieval, redaction, terminal settlement, and authoritative match pagination.
- `price-watch-service.ts` now owns database lifecycles for workspace-scoped watcher listing, activation, history, mutation, disable, and deletion.
- Existing browser routes retain cookie authorization, same-origin mutation checks, hosted-feature checks, request parsing, and stable HTTP response mapping while delegating domain work to the shared services.

## Validation

- `npm test`: PASS — typecheck, Node-adjacent typecheck, production build, and 1,210 tests passed with zero failures.
- `npm run lint`: PASS — zero errors and one pre-existing `no-img-element` warning in `app/components/product-design-lab.tsx`.
- Focused billing/report/price-watch/service suite: PASS — 49 tests passed.
- Real SQLite integration coverage proves report and price-watch tenant isolation, internal-field redaction, reservation settlement inputs, and authoritative match access.

## Fable 5 review

- Verified interactive model: Fable 5 with high effort.
- Initial strict review found one P1 production reservation-release wiring coverage gap and adjacent P2/P3 hardening opportunities.
- The wiring assertion, real-store authorization tests, shared public-failure redaction, async-safe database lifetime, telemetry parity, and task wording were fixed and re-reviewed.
- Final strict verdict: PASS. The final warning-only cleanup uses an explicit public-field pick and does not change the reviewed transport contract.
