# Direct Trigger CLI — separate from the website

## Accepted request

Colleagues install one CLI, supply the company Trigger environment key, run
reports and retrieve complete structured data directly through Trigger.
No Market Signal login, entitlement, database or VPS API calls.
No preset store domains. Website runtime and deployment stay unchanged.

## Architecture

New marketsignal-trigger binary and separately deployed market-signal-direct-*
tasks. Reuse crawl recovery, direct product web search, price extraction,
deterministic recommendations and report quality validation as plain functions.
The company operator deploys these tasks and sets the research provider key once.
Colleagues need only a Trigger private environment key. That key has environment-
wide privileges, so share only with trusted company agents.

Fable architecture review used verified claude-fable-5-1. Accepted its separation
of runtime/deployment credentials, output bounds and single-attempt execution.
Rejected its suggestion to skip discovery: it interpreted the requested rival
COUNT as supplied rival domains. This implementation discovers the rivals.

## Boundaries

- Comparison count means priced pairs; rivals means maximum distinct sellers.
- One bounded search pass (up to 100 new primary searches and 8 minutes),
  no automatic paid retries. Coverage shortfalls are explicit.
- Unknown provider cost is null. No full independent AI recall evaluator yet.
- Existing website tasks, quotas, endpoints and credentials are untouched.
- Branch validation and deployed/live results must be reported separately.

## Validation

- Direct Node contract tests: 7/7 PASS; synthetic injections, no provider calls.
- Full Node suite: 1348/1348 PASS after updating branch README checks.
- Go CLI tests PASS; direct-task typecheck, lint, normal build and VPS build PASS.
- Trigger 4.5.4 deploy dry-run PASS against the company project. No promotion.
- Real company environment key bootstrap used the existing authenticated Trigger
  operator profile. New CLI configure verified it against Trigger and saved it
  through stdin in its isolated OS credential store without printing it.
- User explicitly authorized key reuse; rotation remains recommended.
- Exact-head review, packaged artifacts, deployed tasks and live report remain
  separate release checks; do not label local fixture results as live reports.

## First exact-head review

Verified Fable 5 (`claude-fable-5-1`) reviewed f8f26ea and found one blocker:
large Trigger output can be offloaded instead of inline. Added bounded HTTPS
artifact retrieval with no inherited credentials, no redirects, public-IP DNS
pinning and sanitized errors. Added regression tests and canonicalized rival
roll-up domains. Added optional worker-version pinning for unpromoted branch
acceptance tests; no website deployment or active-worker promotion is implied.

The first unpromoted remote build failed because the config threw when the
remote indexer lacked the operator's local TRIGGER_PROJECT_REF. Reuse the base
config placeholder during remote import; project selection still happens in
the authenticated deployment CLI. The failed version was not promoted and ran
no paid research. Remote deployment must be retried and verified.

Unpromoted 20260904.2 successfully registered 11 tasks and passed real doctor/tools
probes. The first real crawl failed. Reproduced the defect using dry-run output:
the dynamically imported bundled undici module exported only default, so Agent
was undefined and fetch returned the generic network failure. Keep undici external
in the direct config and use Node 22 matching repository requirements. This is a
worker packaging fix; do not weaken network protections or change the website.

The second full Fable review confirmed credential and redirect handling, but
found the artifact body's superjson envelope was not decoded. Verified this in
the installed SDK stringifyIO/exportPacket implementation. CLI now checks MIME
type and unwraps the JSON envelope; tasks normalize output to plain JSON so
unsupported type metadata cannot be emitted. Regression tests cover the actual
SDK envelope, wrong content type, typed metadata, worker-version mismatch, and
INTERRUPTED terminal state. Keeping this branch's README CLI-first is intentional
for colleague handoff, not a change to the published website.
