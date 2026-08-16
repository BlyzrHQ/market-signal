# Task 159 — worker endpoint authorization

## Problem

The Trigger worker sends the private Market Signal callback credential to every
orchestration endpoint, but four expensive worker-only routes do not verify it.
An unauthenticated internet client can therefore invoke crawling, public-source
ad collection, product enrichment, and AI report synthesis outside the paid
report reservation flow.

## Change

- Require the existing `MARKET_SIGNAL_CALLBACK_TOKEN` bearer credential on
  `/api/crawl`, `/api/report`, `/api/ads`, and `/api/enrich-products`.
- Reject missing, malformed, incorrect, and unconfigured credentials before
  request-body parsing or outbound work.
- Reuse the same constant-time verifier and standard unauthorized response as
  the existing matching and action-planning routes.

## Boundaries

- No new credential, authentication mechanism, plan behavior, or public API is
  introduced.
- Only the Trigger orchestration worker calls these routes; browser clients use
  the paid `/api/reports` entrypoint.
- Dependency upgrades, account verification, rate limiting, and security-header
  changes remain separate tasks so this cost-abuse fix can be reviewed alone.

## Review

Verified Claude Fable 5 identified these unguarded routes as the highest-risk
security gap and recommended this focused first PR.

## Validation

- Runtime route tests for missing, malformed, wrong, valid, and unconfigured
  callback credentials on directly loadable worker routes, plus a source-order
  contract covering all four endpoints. The legacy report route dependency
  chain uses extensionless imports, so its guard is checked structurally by the
  standalone Node test runner and through the Trigger HTTP contract suite.
- Existing Trigger orchestration contract tests.
- `npm test`: 872 passed.
- `npm run lint`: 0 errors, 2 pre-existing image warnings.
- `npm run build:vps`: passed, including VPS artifact assertions.
- Staging report run plus tokenless live endpoint verification after deployment.
