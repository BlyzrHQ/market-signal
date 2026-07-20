# Task 064 - Launch and operations runbook

## Goal

Create one factual handoff that explains Market Signal from domain submission
through CLI, crawling, competitor discovery, product matching, ad checks,
persistence, hosting, and public launch. The document must distinguish the
deployed private beta from unimplemented public-launch capabilities.

## Scope

- Document the deployed Sites, D1, Trigger.dev, OpenAI, and Go/Cobra boundaries.
- Explain every intelligence method and its evidence/safety constraints.
- Clarify that all CLI commands accept arbitrary valid public domains and that
  the CLI is currently an API client, not a local Go crawler.
- Record required and optional hosted environment variables without values.
- Define the exact deploy and real-domain verification sequence.
- Publish a prioritized public-launch gate and staged launch recommendation.
- Align `.env.example`, link the runbook from the README, and replace ambiguous
  CLI examples.

## Acceptance

- Every architectural claim traces to current source or an accepted production
  task record.
- No credential value is included.
- The runbook names the D1 90-day expiry marker without falsely claiming an
  automatic purge exists.
- It does not imply complete Meta, Google, or TikTok coverage or exact ad spend.
- It identifies public API auth, abuse controls, billing, retention deletion,
  observability, provider/legal review, and broader benchmark coverage as launch
  work rather than completed functionality.
- Markdown links and commands are valid, `git diff --check` passes, and existing
  Node and Go validation remain green.
- Fable 5 performs a strict architecture/operations review and merges only after
  a PASS and independently verified checks.

## Review record

Fable 5's first strict review returned `BLOCKED`. It found that the draft
mischaracterized the live report API as browser-identity-gated even though saved
report endpoints are anonymously reachable by capability URL. The runbook now
states the actual access model and makes ownership, token authentication, and
quotas hard launch gates. It also qualifies the two-attempt limit as specific to
the report task and documents the legacy synchronous-contract model variables.
Fable 5 re-checked all three corrections and returned
`TASK 64 RE-REVIEW: PASS`. Codex independently verified `310/310` Node tests,
typecheck, production build, lint with zero errors and one pre-existing image
warning, `go test ./...`, `go vet ./...`, and `git diff --check`.
