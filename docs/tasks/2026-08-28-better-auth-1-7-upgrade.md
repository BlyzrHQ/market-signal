# Better Auth 1.7 compatibility upgrade

## Goal

Upgrade Market Signal's existing account authentication from Better Auth 1.6.26 to the current stable 1.7 line without adding MCP or OAuth-provider behavior yet. Existing email/password sign-in, sessions, personal-workspace repair, logout, and account storage must remain compatible.

## Scope

- Upgrade `better-auth` and its lockfile to the exact stable 1.7 version selected for this task.
- Apply only the account-schema compatibility changes required by the current Market Signal login flow.
- Preserve existing users, credential accounts, sessions, and workspace ownership.
- Add regression coverage for schema upgrade and session continuity on an existing 1.6-shaped SQLite database.
- Record the official upgrade guidance and any manual production migration requirement.

## Out of scope

- OAuth provider, MCP, CIMD, JWT, connected-client, consent, or access-token tables.
- Report or price-watch service changes.
- Production MCP endpoint or deployment.

## Acceptance

- Existing authentication tests pass on a fresh database.
- A production-shaped 1.6 database upgrades without deleting or duplicating users, accounts, sessions, or workspaces.
- A pre-upgrade session remains readable after initialization on the upgraded code.
- Full typecheck, lint, build, and test suites pass.
- Strict review has no unresolved blockers before merge.

## References

- Parent PRD: `docs/tasks/2026-08-28-hosted-mcp-reports-price-watch-prd.md`
- Tracking issue: https://github.com/BlyzrHQ/market-signal/issues/201
- Official guide: https://better-auth.com/docs/guides/1-7-upgrade-guide

## Validation

- `node --test tests/account-auth.test.mjs`: 8/8 passing, including a real Better Auth 1.6.26 sign-up/session upgraded in place and resolved by 1.7.2.
- `npm run typecheck`: passing.
- `npm run lint`: passing with one pre-existing `@next/next/no-img-element` warning in `app/components/product-design-lab.tsx`.
- `npm test`: build succeeded and 1,204/1,204 tests passed.
- `npm audit --omit=dev`: 32 pre-existing findings outside the Better Auth dependency tree; this upgrade adds no Better Auth audit finding.
- `git diff --check`: clean apart from Windows line-ending notices.

## Strict review

Verified Claude Fable 5 reviewed the complete implementation diff in read-only mode against the installed Better Auth 1.7.2 source and returned `STRICT PASS`. It found no P0/P1 blockers and confirmed the migration, rollback-on-error behavior, lockfile integrity, session continuity, and fail-closed handling for unsupported provider rows.

## Deployment precautions and limitations

- Take a production SQLite snapshot immediately before deployment. The migration is forward-only for new credential sign-ups: rolling application code back to 1.6 after the schema becomes `issuer NOT NULL` would prevent new 1.6 sign-ups, although existing sessions and sign-ins remain compatible.
- Stop or drain authentication writes while the exact upgraded revision first initializes the production database.
- The runtime schema initializer is the repository's active migration authority. The Drizzle snapshot remains stale and should be reconciled before a future `db:generate`; it has no current production effect because no Drizzle runtime migrator is applied.
- The schema compatibility check currently takes a short `BEGIN IMMEDIATE` transaction per auth context. This preserves correctness under concurrent initialization and can be cached in a later performance-only task.
