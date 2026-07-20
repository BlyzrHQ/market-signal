# Task 054 — Trigger.dev task shell

## Goal

Establish a narrow, deployable Trigger.dev foundation for Market Signal before report orchestration is moved off Sites.

## Scope

- Bind this repository to the existing `market-signal` Trigger.dev project.
- Pin the Trigger SDK/build tooling and CLI scripts to version 4.5.4.
- Add a side-effect-free `market-signal-healthcheck` task with a versioned input/output contract.
- Gate the Trigger config, task wrapper, and pure contract in the repository typecheck and tests.
- Prove the exact reviewed source can deploy and complete one production task run whose output echoes a fresh nonce.

## Non-goals

- No crawling, report orchestration, database writes, Sites callbacks, or third-party requests.
- No application route invokes Trigger.dev in this task.
- No production key is stored in Git, task notes, command output, or Trigger config.

## Runtime boundaries

- The committed Trigger project reference is a public identifier, not a credential.
- `TRIGGER_SECRET_KEY` is server-side runtime configuration for authenticated callers. The Trigger CLI uses its signed-in profile for deployment.
- The healthcheck has one attempt, a 60-second task limit, and a single-concurrency named queue so it reports failures instead of masking them with retries.
- The global task default remains three randomized retry attempts with a five-minute ceiling; later tasks must justify any higher per-task duration.

## Acceptance criteria

1. `npm test` and `npm run lint` pass, with Trigger sources included in typechecking.
2. Pure contract tests run without Trigger environment variables or network access.
3. A secret-pattern scan of the task diff is clean.
4. Trigger production deployment identifies project `proj_ywbhdpqswzbwqoudftcf` and returns a deployed version.
5. A production run of `market-signal-healthcheck` completes and echoes a fresh nonce, contract version, SDK version, and observation timestamp.
6. Strict Fable 5 review passes before PR merge.

## Review and validation

- Fable 5 architecture review: **PASS**. It approved the narrow platform-foundation boundary and required the explicit duration, retry, queue, typecheck, secret-hygiene, deployment, and live nonce gates implemented here.
- Implementation review, production deployment/run evidence, PR, merge, and Sites deployment impact remain pending.
