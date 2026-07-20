# Task 054 - Trigger.dev task shell

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
- Fable 5 implementation review: **FINAL REVIEW PASS**. Fable independently reran the full suite and confirmed 234/234 tests.
- Local validation: `npm test` passed 234/234; `npm run lint` passed with zero errors and one pre-existing `<img>` warning.
- Secret-pattern scan: clean. No Trigger, OpenAI, Meta, or Metapi credential value is present in the task diff.
- Pull request: [#54](https://github.com/BlyzrHQ/market-signal/pull/54).
- Production deployment: Trigger version `20260720.2`, one detected task, deployment `z4ovzit9`, built from source commit `d960ca1`.
- Production run: `run_06fnunkjuq09e8iduca2lmto01` completed with `isTest: false`; payload nonce matched output, contract version was `1`, and SDK version was `4.5.4`.
- Production run evidence: https://cloud.trigger.dev/projects/v3/proj_ywbhdpqswzbwqoudftcf/runs/run_06fnunkjuq09e8iduca2lmto01
- Deployment caveat: Trigger CLI 4.5.4 encoded the original Windows workspace path containing a space as `%20` inside the Linux build image. Deploying the exact same commit from a clean no-space worktree succeeded; no source change or credential workaround was required.
- Sites deployment impact: none. This task adds an external worker runtime shell but does not change the Sites application behavior or its deployed source.
- Merge remains gated on a final strict Fable review of this recorded evidence.
