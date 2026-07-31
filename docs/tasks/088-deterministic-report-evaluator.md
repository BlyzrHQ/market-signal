# Task 088 — Deterministic report evaluator

## Goal

Create the reproducible evaluation foundation approved in Task 086. Every newly
saved terminal report receives an immutable evaluation bound to the exact
presentation document and completed relational fact manifest. Ecommerce reports
are profiled with deterministic formulas and hard-cap signals; reports without a
complete fact manifest fail closed as `insufficient_facts`.

This task does not run an LLM judge and does not expose the internal score to
customers.

## Scope

- Add `report_evaluations` and `report_quality_signals` to Drizzle, runtime
  schema initialization, and migrations.
- Bind evaluations to SHA-256 hashes of the exact compact document JSON and
  completed fact manifest, plus a frozen evaluator version.
- Create evaluation identity alongside terminal document persistence, while
  keeping any evaluation failure isolated from the customer report callback.
- Profile complete ecommerce fact sets from relational companies, products,
  matches, events, and evidence blocks. Never derive product coverage from the
  truncated presentation catalog.
- Persist every numerator, denominator, handling rule, formula score, unknown
  state, and triggered hard cap.
- Persist normalized quality signals for missing competitors, missing pairs,
  unsupported claims, missing primary products, and incomplete fact manifests.
- Keep `rating_basis = deterministic_only`; all hybrid-only dimension scores,
  overall score, and grade remain null.
- Treat reports without product facts as `rubric_unavailable`, retaining only
  deterministic evidence-integrity diagnostics.

## Formula contract

The formulas, points, zero-denominator behavior, half-up rounding, grade bands,
and future hard caps are exactly those approved in Task 086. Components are
computed to four decimal places. `deterministic_score` is the half-up rounded
percentage of applicable deterministic points; hard caps are recorded for the
future hybrid score and are not applied to this diagnostic percentage.

## Deferred launch dependencies

The following remain separate tasks and must land before the model-backed
evaluation pipeline launches: Trigger dispatch, bounded agent judge, dispatch
recovery, owner-only quality UI, factual spot checks, failed/interrupted-run
evaluations, calibrated golden set, and expiry purge. Rows in this task are
deletable by `run_id` before the parent report run so the purge task needs no
schema redesign.

A process crash after evaluation identity creation but before synchronous
profiling can leave a `pending` row. Replaying the terminal save is currently
blocked by report immutability, so the future recovery task remains required to
repair that rare state. No scheduled or model-calling production behavior is
enabled by this task.

## Acceptance criteria

1. Evaluation identity is idempotent and bound to exact document, manifest, and
   evaluator hashes.
2. Missing or non-complete manifests create `insufficient_facts` with no score.
3. Customer report persistence succeeds even if evaluation creation or
   profiling fails.
4. Product, price, image, competitor, and pair metrics use relational facts.
5. Every deterministic formula is reproducible from persisted raw inputs.
6. Unknowns and unavailable phases remain explicit and never become activity
   claims.
7. Hybrid fields stay null and no public report route exposes evaluation data.
8. Replay, concurrency, conflict, zero-denominator, hard-cap, non-ecommerce, and
   failure-isolation tests pass on real Node SQLite where applicable.
9. A fresh real ecommerce report produces a hand-checkable deterministic row.
10. Full test, build, lint, strict Fable 5 review, PR, merge, deployment, and
    live database verification complete under `AGENTS.md`.

## Scope review

A verified `claude-fable-5` high-effort review returned
`TASK_088_SCOPE_PASS`. It approved the deterministic-first split provided no
pending rows are intentionally stranded, no compact catalog is used for fact
coverage, all hybrid fields stay null, customer persistence is isolated from
evaluation failure, and the deferred launch dependencies remain explicit.
