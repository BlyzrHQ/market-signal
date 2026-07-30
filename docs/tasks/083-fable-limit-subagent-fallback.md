# Task 083 — Fable-limit subagent fallback

## Goal

Keep Market Signal work moving when a verified Fable 5 session is unavailable
because of a genuine usage or capacity limit, without misrepresenting who
reviewed or merged a pull request.

## Rules

- Fable 5 remains the normal product review and merge gate when it is
  available.
- An observable rate-limit, quota, overload, usage, or capacity error returned
  by the Claude platform while starting or using a verified Fable session
  activates the fallback. Difficulty, a slow review, an ordinary blocker, or a
  textual claim in model output does not.
- Record the error category, exact non-sensitive message, and timestamp.
- For a normal change, use at least one focused reviewer in a fresh Codex
  subagent session.
- For a high-risk change, use at least two fresh Codex subagent reviewers,
  independently prompted to find blockers without shared implementation
  context.
- High-risk includes changes to `AGENTS.md` or the review/merge workflow,
  deployment configuration, data handling, credentials, authentication, or
  authorization. Treat an unclear classification as high-risk.
- Record the fallback review scope, reviewer outcomes, and Codex's independent
  validation in the task or PR.
- Codex may mark the PR ready and merge only after tests and deployment are
  independently verified and every required fallback reviewer reports no
  blockers.
- Never label a fallback review or merge as performed by Fable.

## Acceptance

1. `AGENTS.md` documents the fallback trigger, minimum review coverage, merge
   gate, and truthfulness requirement.
2. The rule does not silently weaken the existing test, deployment, real-data,
   task, branch, or PR requirements.
3. The change receives the high-risk review tier before merge.

## Validation

- `git diff --check`
- Manual consistency review against the existing Claude review and GitHub
  workflow rules.

## Review

The first verified Fable 5 strict review returned `FAIL` with four major
findings: the trigger lacked observable proof, the fallback merge gate was
weaker than the Fable gate, reviewer counts and independence were ambiguous,
and high-risk work was undefined. The policy now requires a platform error,
preserves independent test and deployment verification, defines explicit
reviewer counts and session independence, and treats workflow-policy changes
as high-risk. The verified Fable 5 high-effort strict re-review returned
`PASS` with no blocker or major finding.
