# Task 119 - Account identity foundation

## Problem

The VPS deployment has no application-owned user identity or report ownership.
The legacy ChatGPT Sites helper trusts identity headers that are not an
authorization boundary on a public VPS, while paid plans require durable users,
sessions, workspaces, and an eventual workspace-to-Stripe-customer mapping.

## Goal

Establish a credential-free, self-hostable identity foundation before adding
Stripe Checkout or accepting real customer credentials.

## Scope

- Prove Better Auth can run through the vinext route layer using the persistent
  Node SQLite database.
- Add the generated Better Auth core tables plus Market Signal workspace and
  membership tables to the reviewed Drizzle schema and migrations.
- Create one personal workspace for a newly authenticated user through an
  idempotent server-side hook.
- Keep providers disabled until their credentials and delivery adapters exist.
- Reject legacy ChatGPT identity headers on the VPS and strip them at Caddy.
- Keep all secrets in environment variables and add placeholders only.
- Omit optional peer tooling such as `drizzle-kit` from the production image.
- Do not add Stripe, paid entitlements, report ownership, or quota charging in
  this task.

## Acceptance criteria

1. The auth handler mounts at `/api/auth/*` using standard Request/Response
   semantics and fails closed when required server configuration is missing.
2. SQLite stores users, accounts, sessions, verification records, workspaces,
   and workspace memberships with uniqueness and foreign-key constraints.
3. Personal-workspace creation is idempotent under repeated callbacks.
4. Directly supplied `oai-authenticated-user-*` headers cannot establish a VPS
   identity and Caddy removes them before proxying.
5. No provider, Stripe, or email credential is committed or required to build.
6. Focused tests, the full build/test/lint suite, strict Fable 5 review, merge,
   deployment, and a live unauthenticated route check pass.

## Architecture decision

Verified Claude Fable 5 (`claude-fable-5`) approved an application-owned,
SQLite-backed session and workspace boundary with billing scoped to workspaces.
Codex selected Better Auth over a hand-rolled magic-link implementation because
it preserves the open-source/self-hosted requirement while reducing custom
authentication and session-security code. Stripe remains a later optional
hosted billing provider, not an identity dependency.

## Validation

- `node --test tests/account-auth.test.mjs`: 6 passed.
- `npm test`: 559 passed, 0 failed.
- `npm run build:vps`: passed; vinext emitted `/api/auth/:all+`.
- `npm run lint`: 0 errors, 2 pre-existing `no-img-element` warnings.
- Dependency audit: Better Auth's optional `drizzle-kit` peer inherits the
  repository's existing advisory chain; the runtime image omits peer tooling.
- Fallback strict review found three blockers: stranded-user recovery, SQLite
  timestamp representation, and fail-open legacy-header target matching. All
  three are fixed with regressions, and the fallback re-review returned PASS.
- Strict Fable 5 re-review remains pending because Claude reported its session
  limit, resetting at 01:30 Africa/Cairo; this task must remain unmerged.
- On 2026-08-09T00:41:48+03:00, a new verified Fable attempt returned the same
  session-limit message. Task 083 therefore activated the two-reviewer high-risk
  fallback. Both fresh reviewers blocked the production package because npm
  retained Better Auth's optional `drizzle-kit` peer; one also found that an
  existing workspace with a missing membership was not repaired. The runtime
  install now omits optional peers and asserts that `drizzle-kit` is absent,
  while workspace reconciliation restores a missing owner membership. Fresh
  fallback re-review and runtime-tree verification are required before merge.
- The corrected production install was reproduced in a detached clean worktree
  with npm 10's exact omit flags: Better Auth, better-sqlite3, and Drizzle ORM
  remained installed while `node_modules/drizzle-kit` was absent. The probe
  worktree was removed afterward. The full suite still passes 559 tests, the
  VPS build passes, and lint has zero errors (two pre-existing image warnings).
