# Task 134: User-authorized review fallback

## Goal

Document a narrowly scoped way for the user to authorize the existing Codex multi-agent review fallback when a genuine Fable 5 attempt cannot complete.

## Scope

- Keep Fable 5 as the default product review and merge gate.
- Require a recorded, genuine Fable attempt before a user-authorized bypass.
- Permit the bypass only for an observable platform usage or capacity error that prevents Fable from returning a verdict; never permit it to override a completed verdict or blocker.
- Bind the capacity incident and immutable authorization to one task-document path, PR number, exact head SHA, and exact target-base SHA; require fresh explicit user authorization after any scope change.
- Consume each capacity incident and authorization after one fallback review cycle, and prohibit fallback whenever a completed Fable verdict already exists for the same revision.
- Give each immutable incident a unique ID, bind authorization to that ID and identical scope, and prohibit fallback after any substantive Fable output, including partial findings or recommendations.
- Record authorization provenance (host-presented user identity, timestamp, verbatim text, and source reference) whenever the optional user-authorized path is used.
- Preserve independent review, tests, deployment verification, blocker resolution, product-truth, and security requirements.
- Require the existing two-reviewer fallback because this policy change is high-risk.
- Record every fresh reviewer session ID and bind every PASS, passing build/lint/test result, evidenced non-applicability, and deployment verification to the same incident ID and full immutable scope tuple.

## Validation

- Review the final policy wording for ambiguity or a path that could silently skip review.
- Obtain independent strict PASS decisions from two fresh Codex reviewers.
- Verify the diff contains no unrelated changes.

## Review record

- User request: On 2026-08-14, the user explicitly requested that `AGENTS.md` document the one-time Fable bypass workflow. The user's earlier one-time bypass authorization applies to `docs/tasks/133-shopify-zero-price-recovery.md` and PR #133 only; its final authorized head SHA must be recorded on that task or PR before the fallback review is counted.
- Task 134 Fable attempt: At `2026-08-14T18:47:20+03:00`, Codex invoked the verified `claude-fable-5` model for a strict read-only review of this policy diff. The Claude platform returned the observable usage error `You've hit your session limit · resets 8:50pm (Africa/Cairo)` before returning a verdict. No Fable review or approval is claimed.
- Fallback review round 1: Two independent strict reviewers returned FAIL. Both found that “genuine attempt” could override a completed Fable blocker. They also required immutable authorization scope and exact-head review/verification. The policy was tightened to address all findings; fresh exact-revision reviews are required.
- Fallback review round 2: Two fresh independent strict reviewers returned FAIL. They required the capacity incident itself to be revision-bound, the authorization record to be immutable rather than rewritable, and the target-base SHA to join the head SHA in every review and verification binding. The policy was tightened accordingly; all prior decisions are stale.
- Fallback review round 3: One exact-revision reviewer returned PASS and one returned FAIL. The blocker required single-use incident consumption, permanent precedence for any completed Fable verdict on the same revision, PASS invalidation after material scope drift, and explicit recorded build/lint/test gates. The policy now includes each boundary; the earlier PASS is invalidated by this change.
- Fallback review round 4: Two fresh exact-revision reviewers returned FAIL. They required partial substantive Fable output to prohibit fallback, authorization to reference one uniquely identified immutable incident and scope, and every applicable check to explicitly pass with evidence for non-applicability. The policy now states those requirements; all prior review results are stale.
- Fallback review round 5: Two fresh exact-revision reviewers returned FAIL. They required provenance fields for optional user authorization, unique reviewer session IDs, and every review/check/deployment record to reference the incident ID plus the complete immutable scope tuple. The policy now requires each field; all earlier evidence is invalidated.
