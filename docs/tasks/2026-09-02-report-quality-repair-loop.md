# Task — Bounded report-quality repair loop

## Goal

Turn the existing domain-to-report workflow into the first finite loop in the
Market Signal graph: create a draft comparison report, evaluate its structural
quality, retry focused comparison research when the requested result count is
short, and either publish a passing report or a transparent bounded result.

The independent post-publication evaluator and coding-candidate metric gate
remain the second loop. They operate on immutable reports and fixed benchmark
inputs; they do not mutate the customer report that triggered an observation.

## Runtime contract

1. The existing crawler and normal resumable comparison attempts remain
   authoritative. Large plans still have ten Trigger task attempts and the
   quality loop does not consume or expand that retry counter.
2. After publication filtering, a deterministic gate verifies the requested
   comparison count, supported non-empty prices, attributable HTTPS sources,
   different primary/rival domains, compatible currencies, unique rival
   product sources, and truthful coverage counts.
3. A quantity-only deficiency may create at most three repair rounds. Each
   round names at most 25 primary products, carries a SHA-256 feedback identity,
   excludes already accepted rival source URLs, and has a three-minute internal
   work budget inside a four-minute worker HTTP deadline.
4. Repair search uses a distinct checkpoint identity containing the feedback
   hash. Replays therefore reuse durable paid-search outcomes rather than
   mistaking the original search for the repair or silently repeating a
   completed repair.
5. Invalid comparison rows are removed before persistence, their deficiency
   codes are recorded, and the paid report continues with the remaining valid
   evidence. Exhausted quantity repair is published as `limited`, with the
   exact remaining shortfall and repair count visible in events/output.
6. The three repair rounds are separate from the existing outer limit of three
   distinct coding candidates. Neither loop can be infinite.
7. Direct search already retrieves and price-validates candidate pages. Final
   enrichment remains available for missing prices/images and compatibility
   with reports that were in flight during rollout. The direct matcher result
   and exact enrichment plan are durably checkpointed first, so a Trigger task
   replay resumes enrichment without repeating comparison search.

## Checkpoint allocation

- `3920..3949`: three immutable quality-feedback slots for each of ten bounded
  Trigger task attempts.
- `3950..3979`: three immutable feedback-bound outcome slots for each of ten
  bounded Trigger task attempts, including explicit `complete`, `incomplete`,
  and `transport-failed` states. Exact feedback/outcome hashes may still be
  reused across task attempts without repeating paid work.
- `4000..4999`: existing per-primary direct-search outcomes. Original and
  repair searches remain separated by feedback-bound input hashes.
- `250..259`: task-attempt matcher-state slots. Version 2 stores a compact,
  identity-bound direct-search graph plus hashed enrichment plan for replay.

No database migration is required.

## Acceptance criteria

1. Pure gate tests cover pass, shortfall repair, exhausted limited output,
   invalid price/source rejection, deterministic feedback, and hash tampering.
2. Direct-search tests prove feedback selects only named products, filters
   already accepted rival URLs, changes checkpoint identity, and reuses the
   repaired checkpoint on replay.
3. Route tests reject malformed or catalog-unbound feedback before paid work.
4. Orchestration tests prove feedback is presented and checkpointed before a
   repair call, a successful repair reaches the target, processing-incomplete
   and transport failures spend a round, durable outcomes are reused, three
   failed rounds terminate as a limited report, and direct enrichment recovery
   does not rematch.
5. The callable graph declares exactly two bounded back-edges: report-quality
   repair and coding-candidate improvement.
6. Type checking, lint, build, focused tests, and a no-cost real-domain fixture
   validation pass before review. No paid production report is launched by
   this task.

## Review record

Before implementation, a verified Fable 5.1 high-effort session reviewed the
architecture. Its blocking findings shaped this task: the terminal report
evaluator is not reused before publication; report repair has a separate bound
from Trigger task attempts; feedback is hash-bound so old paid checkpoints
cannot make a repair a no-op; terminal facts remain immutable; and the free
checkpoint range `3920..3999` is used without a schema migration.

The first exact-diff review returned blockers rather than approval. It found a
missing production `quality` phase, destructive hard-rejection of an otherwise
usable paid report, repair failures that could leak into Trigger's outer retry
budget, missing direct-mode enrichment compatibility, a weakened discovery
completion guard, and missing crash/failure tests. The implementation now:

- persists the `quality` phase through the production report store;
- filters invalid rows and publishes the remaining evidence transparently;
- spends and checkpoints every repair round, including incomplete/transport
  outcomes, without escalating them to an outer task retry;
- restores direct final enrichment and the discovery-completeness guard;
- checkpoints direct matcher state before enrichment; and
- covers direct replay, incomplete repair, failed transport, and outcome reuse.

The follow-up exact-diff review found three recovery regressions: stale repair
outcomes from an earlier report attempt could conflict with fresh feedback,
published direct-search checkpoints could become unrecoverable after stricter
publication rules, and direct search had disabled legacy competitor discovery
outside comparison-target reports. The implementation now replaces only stale
prior-attempt repair outcomes, sanitizes and subset-validates recovered direct
comparison evidence, and skips legacy discovery only when both direct product
search and comparison-target mode are active. Dedicated orchestration tests
cover stale-attempt replacement and a recovered cross-currency pair.

The next exact-diff review found that a direct-search quality repair could run
before multi-wave competitor discovery was complete. That could consume all
three repair rounds against an intermediate draft and leave same-attempt slots
in conflict after a refreshed crawl. The gate now waits for discovery coverage
to complete while still checkpointing partial valid comparisons for the next
wave. Feedback and outcomes have disjoint per-task-attempt namespaces, with
exact prior-task hashes reusable to avoid repeating paid work. Regression tests
prove incomplete discovery makes zero repair calls and a changed task-attempt
catalog can proceed through fresh quality slots.

## Validation record

- `npm test`: PASS — 1,306 tests, including type checks and production build.
- Focused orchestration recovery suite: PASS — 131 tests.
- `npm run lint`: PASS with one pre-existing `@next/next/no-img-element`
  warning in `app/components/product-design-lab.tsx`; zero errors.
- `git diff --check`: PASS (Git emitted only Windows line-ending notices).
- No paid production report or external search was launched for validation.
