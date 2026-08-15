# Task 136 — Beginner-friendly CLI documentation

## Goal

Make the Go CLI understandable and testable for someone who has never used Go
or this repository, without implying that the current hosted API is ready for
public CLI traffic.

## Scope

- Add a dedicated CLI guide covering prerequisites, source and binary usage,
  the safest first run, all commands, global flags, output modes, exit codes,
  environment configuration, troubleshooting, and contribution checks.
- Reduce the root README to a clear product introduction and copyable local
  quick start, with the detailed CLI material linked rather than duplicated.
- Point the operations runbook to the canonical CLI guide while retaining the
  deployment and authentication boundary.
- Test every non-billable help/version path, invalid-input behavior, Go tests,
  Go vet, and documentation links. Do not launch a paid report merely to prove
  documentation formatting.

## Product and data boundaries

- `report` and `crawl` call the same remote `/api/crawl` pipeline; the Go binary
  is an API client and does not scrape websites locally.
- `ads` calls the remote `/api/ads` pipeline.
- These remote commands may consume configured AI/provider resources. Help and
  version commands do not.
- The production deployment does not yet expose scoped CLI authentication or
  per-customer quotas, so public distribution remains blocked.
- Domain examples are illustrative and may be replaced with any valid public
  HTTP domain. No fixture is presented as a live customer result.

## Acceptance criteria

1. A newcomer can verify prerequisites and run CLI help without starting the
   web application or making a remote report request.
2. A local first-run sequence clearly separates the web server terminal from
   the CLI terminal and explains `go -C cli run` in plain language.
3. Every command and global flag is documented from executed help output.
4. Exit codes `0` through `4` are explained, including why code `2` is a useful
   limited result rather than a generic failure.
5. Remote-cost and authentication limitations are visible before runnable
   report examples.
6. The README, CLI guide, and launch runbook have one canonical source of CLI
   details and no conflicting examples.
7. `go -C cli test ./...`, `go -C cli vet ./...`, command smoke checks, relevant
   repository checks, and strict Fable 5 review pass.

## Initial Fable 5 usability review

Verified interactive model: **Fable 5 with high effort**.

Fable inspected the README, CLI implementation, contracts, and repository
layout. It ran `go version`, `node --version`, `go -C cli test ./...`, and
`go -C cli run ./cmd/marketsignal version`. The Go suite passed and source-run
version output was correctly `dev`.

The material finding was that the current README assumes readers understand
Go's `-C` and `run` behavior and mixes a minimal command list with unrelated
starter and hosting material. Fable recommended a short first-run path plus a
dedicated guide that explains the two-process local workflow, API-client
boundary, configuration, exit codes, and production-authentication warning.

## Validation

Independent validation on Windows with Go 1.26.4:

- `go -C cli test ./...` — PASS across API, command, contract, and render
  packages.
- `go -C cli vet ./...` — PASS.
- `go -C cli build -o <temporary-path> ./cmd/marketsignal` — PASS.
- Built-binary root, report, crawl, and ads help — exit `0`.
- Built-binary `version` — exit `0`, output `dev` as expected for an unstamped
  source build.
- Invalid `localhost` analysis target — exit `1`.
- Invalid `--output yaml` — exit `1`.
- Unreachable controlled endpoint at `127.0.0.1:1` — exit `4`.
- No report-producing endpoint or paid evaluation was invoked by these checks.

## Final Fable 5 review

Verified interactive model: **Fable 5 with high effort**.

Strict verdict: **PASS**. Fable reported no blocker or major findings. It
independently matched flags, defaults, environment behavior, endpoints, domain
validation, prerequisite versions, API-client boundaries, and exit codes to the
implementation. It reran the Go tests and vet checks, exercised help, version,
and invalid-local-domain behavior, and confirmed that no report-producing
endpoint was invoked.

Two non-blocking observations were retained: Cobra also accepts comma-separated
values for the documented repeatable `--competitor` flag, and shell completion
is intentionally routed to Cobra's generated per-shell help instead of being
duplicated in this guide.

Pending PR checks and merge. Deployment is not applicable because this task
changes repository documentation only and does not alter a runtime artifact.
