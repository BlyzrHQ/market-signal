# Internal CLI GitHub handoff

## Request

Remove the brand-specific CLI example and provide a GitHub branch with the
instructions, rather than directing the colleague to a website guide.

## Scope

- Put a company CLI quick start at the top of README.
- Expand the internal guide with source-build, configuration, report, resume,
  output-field and cost-boundary instructions.
- Replace the example domain in the guide and CLI page source with example.com.
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
