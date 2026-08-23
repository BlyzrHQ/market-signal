# Acceptance workflow without host jq

## Outcome

Make the production acceptance workflow runnable on the hardened production
runner without installing another host package or weakening its one-report
boundary.

## Cause

The first authorized Starter invocation stopped before dispatch because the
self-hosted runner does not install `jq`. No report or provider request was
created.

## Change

- Build the bounded request body inside the already-deployed application
  container with Node.js.
- Validate the returned public report ID, Trigger run ID, and comparison target
  inside Node.js and again in Bash.
- Return only a tab-delimited, pattern-bounded handoff to Bash.
- Keep owner-write authorization, exact deployed-revision validation, protected
  production environment, and single-workflow concurrency unchanged.

## Validation

- Packaging regression rejects any `jq` dependency in this workflow.
- The focused packaging and acceptance-route tests pass.
- The workflow is reviewed as a production-configuration change before merge.
- After merge, invoke only one Starter report for `myjam.co.uk`; do not invoke
  another plan or an evaluation.
