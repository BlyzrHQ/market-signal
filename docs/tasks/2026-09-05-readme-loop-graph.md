# README: current report loop and deferred coding loop

## Request and scope

Add the agreed full loop graph to the branch README. The user explicitly wants
the existing `codex/trigger-workflow-parity` branch and wants to keep the coding
agent for later. This is a documentation-only follow-up to draft PR #227; do not
create a parallel implementation, merge the PR, promote a worker or deploy.

## Documentation changes

- Show domain entry, per-product search, priced comparison drafts, deterministic
  quality checks, scoped feedback, bounded repairs and structured CLI output.
- Explain the three-repair-round limit per orchestration attempt, separately
  from Trigger retries and continuation passes; do not promise complete coverage.
- Show the deferred post-report evaluator/coding-agent path in a separate,
  explicitly unconnected subgraph: candidate branch, fixed benchmark, metric
  gate, rejection/retry, human review and normal approved deployment.
- Distinguish current within-report repair from future cross-report software
  improvement. Saved reports remain immutable; no subscription worker is wired.
- Link the diagram to the existing runtime and pure graph/metric-gate modules.

## Validation and review

- `git diff --check`: passed.
- README relative links: 8/8 resolve. Mermaid structural checks: one block,
  two subgraphs, 29 defined identifiers and 31 edges with valid endpoints.
  This is a structural check, not a GitHub screenshot/rendering assertion.
- `node --test tests/market-signal-loop-graph.test.mjs tests/report-quality-gate.test.mjs tests/trigger-workflow-parity.test.mjs`:
  35/35 offline tests passed, including fixed stored real-report evidence.
- `npm run build`: passed. No deployment was performed.
- Initial `npm run lint` included pre-existing generated `.trigger/tmp` bundles
  and failed on those artifacts. `npm run lint -- --ignore-pattern '.trigger/**'`
  passed with zero errors and one existing `no-img-element` source warning.
  No lint rules or configuration were changed to obtain that result.
- Read-only documentation review: verified `claude-fable-5-1`, session
  `99bad22d-445a-48b1-b1b3-5b656d2793d5`, returned **PASS** without blockers.
  Scope was this README/task-note change, not a new review of the whole PR.
  Claude Code used the existing subscription login; no API-key fallback.
- Reviewer nits were independently checked: the three distinct candidate limit
  exists in `market-signal-loop-graph.ts` and the pure improvement gate; quality
  event history is returned by `workflow-output.ts` under `evaluation.events`
  and `progress`. Neither finding required changing the reviewed README.
- No new live report or paid research/evaluation was launched. Future coding
  worker implementation, hosting and subscription provisioning remain deferred.

## Deployment and data boundaries

Only README.md and this task note are in scope. No runtime code, credentials,
customer data, report facts, deployment configuration or review rules change.
The existing unpromoted Trigger deployment is unchanged. Website/VPS deployment
is not applicable to this documentation update. The graph is explanatory, not
evidence that the deferred coding worker is implemented or running.
