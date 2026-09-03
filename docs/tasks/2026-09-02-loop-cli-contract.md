# External loop CLI contract

## Goal

Expose the existing durable Market Signal report workflow to another loop through the Go CLI. The CLI must submit one idempotent request, wait by polling, and return a bounded decision-ready JSON result rather than only a report link.

## Scope

- Add `submit`, `wait`, and `result` commands alongside the existing `report`
  and `crawl` command surface. Mutating POST commands no longer retry an
  ambiguous transient failure automatically because a retry could duplicate
  paid work.
- Keep Trigger, retries, billing, and report-quality repair inside the service.
- Require a caller-generated request id and preserve it through every response.
- Validate terminal responses against `contracts/report-result.v1.schema.json`.
- Inline at most 50 normalized comparison rows; larger plans expose a private,
  report-bound continuation endpoint using the identical row schema.
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
- `8`: authoritative report facts are unavailable or inconsistent; stop retrying
  and inspect the report/storage state

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

On 2026-09-03, Fable 5.1 reviewed the follow-up requirement to return the
actual report comparisons and competitors to another agent. It found the
original opaque row contract and five-row human preview insufficient. The
contract now names and validates both products, positive prices, evidence,
source URLs, match semantics, price arithmetic, competitor counts, and stored
recommendations; the human renderer emits every inline row. Fable also required
report-bound pagination and fail-closed handling for inconsistent stored facts,
which are included in this update. Two follow-up static reviews found no
confirmed blocking defect. Their notes led to explicit documentation of
single-attempt paid POSTs, `facts-inconsistent` contract-error mapping, a
distinct non-retryable CLI exit code, evidence-backed match-method hydration,
and normalized URL-length validation. Fable's sandbox denied every requested
test command, so it did not issue an unqualified strict merge `PASS`; the PR
must remain draft until that formal gate is closed even though Codex
independently executed the validation below.

## Validation

- Go unit and integration tests cover submit, pending-to-terminal wait, result
  rendering, controlled bearer forwarding, request identity drift,
  cancellation, true timeout, permanent fact failures, and every terminal exit
  code.
- TypeScript tests cover result projection, owner/request binding,
  controlled-versus-hosted authorization, storage replay/conflict, durable
  dispatch detection, and idempotent recovery of a persisted-but-undispatched
  replay.
- Existing `report` and `crawl` command names, output modes, and exit codes 0-4
  remain available; their mutating POST transport is now deliberately
  single-attempt and requires an intentional caller retry.
- No live report is launched by these tests.
- Real public-data projection check (2026-09-03, no AI/provider call): the
  existing MyJam production-evidence pair `Spinach Bunch` was re-fetched from
  `https://myjam.co.uk/products/spinach-bunch` and
  `https://desiibasket.com/products/spinach-bunch`. Both pages resolved without
  a coverage gap and exposed positive GBP prices (`GBP 1.36` and `GBP 0.89`).
  The exact server projector returned one authoritative normalized comparison,
  one `desiibasket.com` competitor roll-up, a `GBP 0.47` / `35%` rival-lower
  gap, both source URLs and timestamps, match provenance, and a deterministic
  action. This was a contract validation envelope, not a customer report or a
  paid report run.
- `npm test`: 1,318 passed, 0 failed (includes typecheck, Node typecheck,
  production build, and the full JavaScript test suite).
- `node --test tests/report-loop-result.test.mjs`: 12 passed, 0 failed,
  including normalized comparison projection, private report-bound pagination,
  request/owner authorization, and fail-closed empty-price/source validation.
- `go test ./...` and `go vet ./...`: passed.
- All four JSON contract schemas parse, and `git diff --check` passes.
- `npm run lint -- --ignore-pattern .trigger`: 0 errors; one pre-existing
  `@next/next/no-img-element` warning remains in
  `app/components/product-design-lab.tsx`.

## Known limitations

- A self-hosted integration that supplies an authenticated actor but omits the
  billing reservation adapter does not enforce plan reservations. Deployments
  that need quotas must provide that adapter; the hosted service does.
- Replaying a failed hosted command after its reservation has been released can
  return a reservation error; the original terminal result remains readable
  through `result`.
- Caller request ids are globally unique in the current store. A collision from
  another workspace fails closed rather than exposing or replaying its report.
