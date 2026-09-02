# External loop CLI contract

## Goal

Expose the existing durable Market Signal report workflow to another loop through the Go CLI. The CLI must submit one idempotent request, wait by polling, and return a bounded decision-ready JSON result rather than only a report link.

## Scope

- Add `submit`, `wait`, and `result` commands alongside the unchanged legacy `report` and `crawl` commands.
- Keep Trigger, retries, billing, and report-quality repair inside the service.
- Require a caller-generated request id and preserve it through every response.
- Validate terminal responses against `contracts/report-result.v1.schema.json`.
- Inline at most 50 comparison rows; larger plans keep pagination metadata for later export.
- Preserve unknown provider cost as `null`, never zero.
- Exercise the full CLI flow against an authenticated local HTTP test service without crawling a domain or spending provider credits.
- Add the durable `/api/reports/{publicId}/result` projection used by the CLI.
- Persist the caller request id and bind reads to it. Exact replays return the
  same report; an undispatched queued report repeats only the existing
  idempotent Trigger dispatch so a persistence/dispatch crash cannot strand it.
- Allow the existing deployment-wide API token only on non-hosted, controlled deployments; hosted billing keeps cookie authentication and does not gain a bearer bypass.

## Deliberate boundary

This task implements the CLI and its server-side contract for a controlled,
single-tenant deployment. It does not add an unsafe production authentication
shortcut. A following high-risk task must add workspace-scoped bearer
credentials and rate limiting before the CLI is supported against the hosted
deployment.

## Commands

```text
marketsignal submit <domain> --request-id <id> [--locale en|ar]
marketsignal wait <public-report-id> --request-id <id> [--poll 15s] [--max-wait 60m]
marketsignal result <public-report-id> --request-id <id>
```

## Exit codes

- `0`: complete terminal result
- `2`: limited terminal result
- `3`: response contract drift
- `4`: transport, authentication, or service error
- `5`: failed terminal result
- `6`: pending, interrupted/outcome unknown, or wait timeout
- `7`: quota or subscription refusal

## Architecture review

Claude Fable 5.1 (`claude-fable-5-1`) completed the architecture review on
2026-09-02. It recommended keeping the CLI as a thin client of the durable
report API, keeping Trigger internal, requiring an explicit idempotency id,
polling instead of server-side long polling, returning at most 50 inline rows,
and separating hosted workspace-scoped API keys from this controlled-deployment
contract. Its first strict code review returned `BLOCKED` for missing server
idempotency, result production, semantic validation, identity binding, and
adversarial tests. A second strict review found one remaining persistence-to-
dispatch crash window: an undispatched replay could remain queued forever. The
replay path now checks the durable dispatch receipt and recovers only the same
Trigger idempotency key, while preserving the actual lifecycle state. The exact
fix received a strict `PASS` from verified Claude Fable 5.1 on 2026-09-02. The
review was read-only; Fable's environment could not execute commands, so Codex
independently ran every validation listed below after the fix.

## Validation

- Go unit and integration tests cover submit, pending-to-terminal wait, result rendering, controlled bearer forwarding, request identity drift, cancellation, true timeout, and every terminal exit code.
- TypeScript tests cover result projection, owner/request binding,
  controlled-versus-hosted authorization, storage replay/conflict, durable
  dispatch detection, and idempotent recovery of a persisted-but-undispatched
  replay.
- Existing CLI commands and exit codes 0-4 remain unchanged.
- No live report is launched by these tests.
- `npm test`: 1,314 passed, 0 failed (includes typecheck, Node typecheck,
  production build, and the full JavaScript test suite).
- `go test ./...` and `go vet ./...`: passed.
- `npm run lint -- --ignore-pattern .trigger`: 0 errors; one pre-existing
  `@next/next/no-img-element` warning remains in
  `app/components/product-design-lab.tsx`.
