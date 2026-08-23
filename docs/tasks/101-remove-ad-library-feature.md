# Remove ad-library feature

## Goal

Remove ad-library progress, execution, report UI, API, CLI, configuration, and current product promises. New reports must not perform or publish ad analysis.

## Compatibility boundary

- Keep the existing database columns, fact kind, retention accounting, and document compaction needed to read historical reports.
- Keep the legacy ad-record URL validator used when old relational facts are loaded.
- Historical ad blocks may remain in stored API payloads, but current customer pages do not render them.
- No database migration or customer-visible fact rewrite is part of this task.

## Acceptance criteria

- New orchestration emits no ad events, makes no ad API call, and persists an `ads: 0` fact count.
- Loading and report pages contain no ad-library or advertising UI/copy; legacy ad progress events are filtered from the loading feed.
- `/api/ads`, the CLI `ads` command, its schema, and provider credentials are removed.
- Worker preflight no longer requires ad execution; the old capability remains advertised for one compatibility release during Trigger-first deployment.
- Existing reports and retention paths with legacy ad facts continue to load and validate.
- JS tests, typecheck, lint, Go tests/vet/build, and the open-source startup smoke test pass.
- Trigger is deployed and verified before the exact approved VPS commit, without launching a paid report.

## Review

Fable 5 architecture review (2026-08-23) recommended cutting the feature at orchestration while retaining only legacy storage/read tolerance. It identified old-worker/new-app deployment skew as the primary risk; deployment must therefore verify the new Trigger version before removing the VPS endpoint.
