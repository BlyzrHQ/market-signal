# Task 134: User-authorized review fallback

## Goal

Document a narrowly scoped way for the user to authorize the existing Codex multi-agent review fallback when a genuine Fable 5 attempt cannot complete.

## Scope

- Keep Fable 5 as the default product review and merge gate.
- Require a recorded, genuine Fable attempt before a user-authorized bypass.
- Permit the bypass only for an observable platform usage or capacity error that prevents Fable from returning a verdict; never permit it to override a completed verdict or blocker.
- Bind authorization to one task-document path, PR number, and exact head SHA; expire it after one review cycle or any head change.
- Preserve independent review, tests, deployment verification, blocker resolution, product-truth, and security requirements.
- Require the existing two-reviewer fallback because this policy change is high-risk.
- Require all fallback reviewers and verification to cover the same final head SHA; invalidate prior PASS decisions after any change.

## Validation

- Review the final policy wording for ambiguity or a path that could silently skip review.
- Obtain independent strict PASS decisions from two fresh Codex reviewers.
- Verify the diff contains no unrelated changes.

## Review record

- User request: On 2026-08-14, the user explicitly requested that `AGENTS.md` document the one-time Fable bypass workflow. The user's earlier one-time bypass authorization applies to `docs/tasks/133-shopify-zero-price-recovery.md` and PR #133 only; its final authorized head SHA must be recorded on that task or PR before the fallback review is counted.
- Task 134 Fable attempt: At `2026-08-14T18:47:20+03:00`, Codex invoked the verified `claude-fable-5` model for a strict read-only review of this policy diff. The Claude platform returned the observable usage error `You've hit your session limit · resets 8:50pm (Africa/Cairo)` before returning a verdict. No Fable review or approval is claimed.
- Fallback review round 1: Two independent strict reviewers returned FAIL. Both found that “genuine attempt” could override a completed Fable blocker. They also required immutable authorization scope and exact-head review/verification. The policy was tightened to address all findings; fresh exact-revision reviews are required.
