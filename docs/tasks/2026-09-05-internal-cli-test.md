# Internal CLI handoff test

## Scope and revision

Test the company CLI linked from `codex/internal-cli-handoff`, source revision
`8d45ea7bc4581033c0c129819d30a2a03e833204`. This task records test evidence only;
it changes no executable code, credentials, quotas, or deployment configuration.
Testing ran on Windows with Go 1.26.4 on September 5, 2026 local time
(September 4, 2026 UTC, approximately 21:25 UTC).

## Independent validation

- Documented `go -C cli build -o ../marketsignal-internal.exe ./cmd/marketsignal-internal`: PASS.
- Executable `version`: exit 0, `dev`; report help: exit 0.
- `go -C cli test ./... -count=1`: PASS; JSON event count confirms 69 passing
  tests including subtests, zero failures. HTTP test fixtures are synthetic,
  not live report evidence.
- `go -C cli vet ./...`: PASS.
- `node --test tests/cli-distribution.test.mjs`: 5 passed, zero failures.
- Executable rejects missing request ID, unsupported target 21, loopback
  domain, unsupported output format, and invalid result/wait IDs with exit 1.
- Executable rejects overriding the production origin with exit 4 before
  sending the stored credential.
- Full website build/lint/Node suite was not rerun: no website or runtime
  implementation changed; validation focuses on the Go CLI and handoff tests.

## Live production attempt

Executed the built binary using the already-provisioned OS credential:

```powershell
.\marketsignal-internal.exe report myjam.co.uk --comparisons 20 --request-id codex:cli-test:myjam:20260905:001 --output json --max-wait 30s --timeout 20s
```

Production `https://signal.blyzr.com` returned HTTP 429:

> The internal UTC-day ceiling has 20 of 20 comparison units reserved; this report would exceed it.

The executable exited 7, correctly identifying quota/entitlement failure.
This verifies production connectivity, acceptance of the saved credential,
and enforcement of the internal daily budget. It does not verify a newly
completed report, delivered comparisons, evaluation, or live wait/result.
No report ID or report data was returned. No quota or credential changes were
made. A fresh end-to-end report remains blocked by the existing daily ceiling;
retry the same request ID once capacity is available.

## Handoff observations

- Confirmed input-validation defect: `report myjam.co.uk --comparisons 0
  --request-id codex:cli-test:zero:20260905:001 --output json --timeout 20s`
  reaches production, receives HTTP 400 (`Comparison target must be 20, 50,
  500, or 1000.`), and exits 4. Other invalid targets are rejected locally
  with exit 1. In `report.go:48`, zero maps to an empty plan, then
  `validPlanTarget` in `loop.go:263` treats a missing map key as zero. This
  misclassifies invalid input as authentication/transport failure. The server
  rejects the request before creating report work. Runtime fix is outside this
  test-only task.
- The guide's exit-code list omits exit 1, reproduced for invalid input.
- `--output json` does not make quota failures JSON: stdout is empty and the
  diagnostic is plain text on stderr. Agent callers must inspect exit codes
  before parsing stdout. This is an observed limitation, not a report result.
- Happy-path, resume, conflict, and missing-credential unit checks pass with
  test fixtures; these do not establish production report quality.

## Publication and deployment boundary

Publish this evidence as a draft PR targeting the tested handoff branch. No
runtime changes require deployment, and no deployment is performed. The live
service was reachable and enforced its quota; its deployed revision was not
independently verified. Do not describe the CLI as fully accepted end to end.

## Claude review

Read-only Claude CLI review completed in session
`a99f5cee-7631-473a-bf75-234175370020`. Tool result `modelUsage` verified the
actual model identifier `claude-fable-5-1` (Fable 5.1). Scope: command/documentation
alignment and interpretation of test results. Review identified the zero-target
defect; Codex independently reproduced it against production as recorded above.
It confirmed the exhausted daily entitlement prevents end-to-end acceptance.
Other observations included the unignored generated executable, default
20-pair cap, and private/open-source wording. Speculative findings were not
treated as verified failures. This is a findings review, not a strict merge
PASS; keep the evidence PR in draft. Tests were run independently by Codex.
