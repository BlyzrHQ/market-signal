# Direct-search PageSignal recovery

## Problem

A production Starter acceptance report for `myjam.co.uk` failed after the direct-search matcher committed five priced comparisons across its first two primary products. The third primary product committed a paid-search lead checkpoint, then every matcher retry failed before that checkpoint could be upgraded to a priced outcome.

- Report: `c0c9c22805084d7899834d2624ea84c5`
- Trigger run: `run_06g39pjrgm1nv48hrs0e2qpo01`
- Production revision: `a2704dae5c253b6ad3b6ba9492dfab8e4e177651`
- Trigger version: `20260824.3`

Read-only production inspection showed the stuck product was `Abido 7 Spices Bag 500G`. Its search checkpoint contained three candidate pages. Local replay of those exact public candidates reproduced `Direct product enrichment returned an invalid durable outcome.` The successful priced rival was extracted as a page-scoped `PageSignal`; the direct-search checkpoint validator accepted only structured `Product` records even though downstream direct-search publication accepts source-linked priced page evidence.

## Change

- Add a regression test using a priced, identity-accepted `PageSignal` rival.
- Allow durable direct-search outcome checkpoints to retain `Product` or `PageSignal` product-page evidence without changing its source classification.
- Keep the existing no-empty-price, source URL, freshness, supported-currency, and checkpoint-integrity requirements.

## Acceptance

- Focused direct-search and route/store tests pass.
- Full typecheck, build, lint, and test suite pass.
- Review and merge follow the repository gate. A verified Fable 5 session was attempted first; because it ended on an observable usage limit before returning a verdict, a fresh focused Codex reviewer must report no blockers before Codex may merge.
- Trigger is deployed before the exact merged VPS revision.
- A fresh `myjam.co.uk` Starter report reaches a terminal customer-visible state and publishes priced comparisons.
- Four additional Starter reports from distinct domains are run sequentially only after MyJam succeeds.

## Spend guard

The complete five-report exercise has a hard USD 20 ceiling. Paid production reports are sequential and stop on the first failure. Before this fix, one failed MyJam Starter report and one local diagnostic product search were used; provider cost is not exposed, so the remaining budget is tracked conservatively and no high-volume plan is authorized.

## Data boundaries

Only public product pages are used. Search leads remain separate from verified priced page outcomes. Empty, zero, malformed, stale, or unsupported-currency prices remain excluded.

## Review record

- `2026-08-24T18:16:49.1086380Z`: verified first-party `claude-fable-5` review attempt ended before a verdict with category `budget_exhausted`, subtype `error_max_budget_usd`, and the non-sensitive message `Reached maximum budget ($2)`. This is not a Fable approval. Per `AGENTS.md`, review falls back to a fresh focused Codex reviewer.
- `2026-08-24T18:21:17.2513802Z`: fresh focused Codex fallback reviewer inspected the exact current diff and surrounding persistence/replay contracts and returned `PASS — no blockers`.
