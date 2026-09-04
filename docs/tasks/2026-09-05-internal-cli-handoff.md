# Internal CLI GitHub handoff

## Request

Remove the brand-specific CLI example and provide a GitHub branch with the
instructions, rather than directing the colleague to a website guide.

## Scope

- Put a company CLI quick start at the top of README.
- Expand the internal guide with source-build, configuration, report, resume,
  output-field and cost-boundary instructions.
- Follow-up: remove all prefilled report domains from CLI instructions and page
  source; use quoted input placeholders only. Replace real-brand Go fixtures
  with reserved synthetic primary.example data, served by local mock servers.
- Add a regression test proving missing/placeholder domains make zero HTTP calls.
- The regression first caught an HTTP call for a literal placeholder. Reject
  angle-bracket placeholders locally before credential lookup or HTTP requests.
- Preserve the separate customer CLI; do not alter auth, quotas or transport.
- Branch-only handoff: no merge, production deployment or paid report requested.

## Validation

- Documented Go build succeeds; built executable prints `dev` and report help.
- `go -C cli test ./...`: PASS.
- `node --test tests/cli-distribution.test.mjs`: 5/5 PASS.
- `npm run lint`: PASS, existing img warning only.
- `npm run build:vps`: PASS.
- `git diff --check`: PASS.
- Exact-head Fable review and GitHub handoff verification recorded in the PR.
All domain examples are placeholders, not evidence of a live report.
