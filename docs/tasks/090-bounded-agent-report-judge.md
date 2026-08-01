# Task 090 — Bounded agent report judge and recovery

## Goal

Turn the deterministic evaluation created in Task 088 into a durable hybrid
report rating. A background Trigger.dev worker judges only the persisted,
enumerated report evidence, stores a constrained evidence-cited result, and
fails back to the deterministic evaluation without affecting report delivery.

This task does not expose the internal rating to customers, run independent web
spot checks, build the owner dashboard, or change report-generation behavior.

## Scope

- Stop completing deterministic profiling inside the customer document-save
  callback. Saving a terminal report creates an idempotent outbox/evaluation row
  and returns the customer report immediately. The report-orchestration Trigger
  task reads the returned evaluation identity and dispatches evaluation only
  after the report callback has succeeded; the 15-minute recovery schedule is
  the authoritative fallback if that best-effort dispatch is interrupted.
- Freeze `evaluated_at`, model, prompt version, rubric version, pricing version,
  input/output token limits, maximum reserved cost, document hash, manifest
  hash, and evaluator version when the evaluation row is created. Deterministic
  freshness uses this frozen timestamp, never worker start time.
- Use an explicit state machine:
  `pending|dispatch_failed -> dispatching -> profiling -> ready_for_judge -> judging ->
  complete|agent_rejected|failed`. `insufficient_facts` and
  `rubric_unavailable` remain terminal. Every nonterminal transition uses a
  lease token, lease generation, and lease expiry in a compare-and-set update.
- Add authenticated, bounded worker endpoints to:
  - lease one evaluation and return its exact frozen binding;
  - persist deterministic profiling before any model call;
  - return a bounded judge packet containing the deterministic profile, compact
    report, and enumerated evidence IDs;
  - accept one idempotent terminal judge result; and
  - atomically claim at most 25 dispatches by opaque evaluation ID without
    exposing customer tokens or report prose.
- Add a 15-minute recovery task. It reclaims expired `profiling` and
  `ready_for_judge` leases and claims recoverable rows older than five minutes.
  A claim CAS sets `dispatching`, stores a random dispatch lease token/expiry,
  and allocates the next `dispatch_generation`; this allocation increments
  `dispatch_attempts`, which is capped at three. Each generation uses
  `evaluation:<id>:<evaluator_version>:<generation>` with a 90-day Trigger
  idempotency TTL. The recovery worker acknowledges the exact lease token and
  generation with the Trigger run ID. Concurrent claimers cannot allocate the
  same generation.
- The task payload carries the opaque dispatch lease token and generation. An
  accepted evaluation worker may atomically consume that exact claim directly
  from `dispatching -> profiling` before `tasks.trigger` returns to the
  dispatcher. A later acknowledgement may fill `trigger_run_id` when the row is
  already `profiling`, `ready_for_judge`, `judging`, or terminal, but may never
  regress state. Likewise, an ambiguous-dispatch update is a CAS on the still-
  `dispatching` token/generation and cannot overwrite worker progress.
- A Trigger transport error is treated as ambiguous. The application records
  `dispatch_outcome = unknown` and a bounded transport-attempt count while
  retaining that generation. Recovery reclaims and retries the same generation
  and idempotency key, so an already accepted Trigger request is replayed rather
  than duplicated. Three unconfirmed transport attempts terminalize the row as
  failed; a confirmed run that makes no state progress after its worker lease
  window may allocate the next generation. Database leases, not a permanent
  Trigger key, provide worker exclusion. Three allocated generations without
  completion become `failed` with
  `evaluation-dispatch-exhausted`.
- `judging` is an at-most-once barrier. The worker commits that state before the
  Responses API request. It alone may commit the terminal result. If its lease
  expires after entering `judging`, recovery must not issue another model call;
  it terminalizes the row as `agent_rejected` / deterministic-only with
  `agent-call-outcome-unknown`. A crash before the request can therefore lose a
  semantic score, but it can never create an ambiguous duplicate charge.
- Use one strict-schema Responses API call. Website and report prose are
  untrusted data, never instructions. The judge cannot browse, call tools,
  recalculate deterministic facts, raise hard caps, or cite IDs outside the
  supplied set.
- Default the evaluator to `gpt-5.6-luna`, independently configurable through
  `MARKET_SIGNAL_EVALUATOR_MODEL`. Freeze the direct-API standard short-context
  rates published on 2026-07-31 (`$0.20 / 1M` input tokens, `$0.02 / 1M`
  cached-input tokens, and `$1.20 / 1M` output tokens) as pricing version
  `openai-standard-2026-07-31`, plus a prompt version, input/output-token cap,
  and maximum reservation of USD 0.02. Any other model has no matching frozen
  price and fails closed before the model call.
- Use a versioned allowlist packet instead of sending the compact document
  wholesale. Canonical JSON is at most 48 KiB and contains at most 80 evidence
  records in deterministic ID order. Each record has an opaque ID, claim type,
  bounded 500-character excerpt, source role/domain (not a raw URL), observed
  date, and deterministic relevance metadata. Include at most 30 candidate
  actions or comparisons and at most 20 explicit gap records. Strings are
  length-bounded and control characters removed. The packet hash is persisted
  before `ready_for_judge`.
- Reserve against 60,000 uncached input tokens and 2,000 output tokens before
  entering `judging`; at Luna's frozen standard rates the reservation is
  14,400 microusd (15,840 microusd including the documented 10% regional
  uplift), below the 20,000-microusd ceiling. The request uses no tools, a
  45-second timeout, `max_output_tokens = 2000`, and a strict JSON schema. The
  HTTP response body is capped at 64 KiB.
- Reject malformed JSON, schema violations, unknown evidence IDs, uncited
  conclusions, unsupported numeric claims, or a result that exceeds the frozen
  score allocations. Rejection preserves the deterministic evaluation as
  `agent_rejected` with `rating_basis = deterministic_only`.
- For an accepted judge result, calculate hybrid dimension scores and weighted
  overall score in application code, apply the lowest deterministic hard cap,
  round half-up, assign the frozen grade band, and persist model, prompt,
  pricing, usage, cost, findings, and at most three proposals.
- Keep terminal rows immutable and make Trigger retries safe: once a
  `judging` or terminal result is recorded, retrying cannot issue another model
  call.
- Add a bounded backlog materializer: each recovery pass creates at most 25
  current-version rows for terminal persisted reports that do not yet have one.
  Reports with complete fact manifests become pending. Reports without complete
  facts receive terminal `insufficient_facts`; missing historical evidence is
  never synthesized to manufacture a rating.
- Add evaluation-only capability names to the additive advertised capability
  set without changing protocol version 1 or legacy required capabilities. Use
  a separate `MARKET_SIGNAL_EVALUATION_TOKEN` for evaluation endpoints and the
  evaluation/recovery Trigger tasks; the orchestration callback token cannot
  enumerate or mutate evaluations.
- Retention excludes a run while any evaluation lease is unexpired. Lease
  acquisition also refreshes the parent run heartbeat. Expired leases are
  reconciled before the run can become purge-eligible.

## Data boundaries

- Positive and negative semantic conclusions cite supplied evidence IDs.
- No raw secret, customer access token, cookie, or arbitrary URL is sent to the
  model.
- Missing ads or unavailable coverage remain unknown states, not zero activity.
- The judge's score is an internal diagnostic. It cannot edit prompts,
  thresholds, crawler policy, source admission, production code, or a customer
  report.
- Full report facts remain in the relational tables; the worker receives a
  bounded packet and never direct database access.
- Findings contain at most 12 records, proposals at most three, and each record
  cites one to five supplied evidence IDs. Reasons are capped at 500 characters.

## Acceptance criteria

1. Report availability is independent of evaluation dispatch and model health.
2. Evaluation identity and every worker transition verify evaluation ID,
   document hash, manifest hash, and evaluator version.
3. Deterministic profiling and the canonical packet hash are durably stored
   before a model request; `judging` is durably stored before dispatch, and no
   replay from `judging` can call the model again.
4. The model receives one bounded, tool-free, strict-schema request and cannot
   introduce unknown evidence or override deterministic facts or caps.
5. Accepted output yields reproducible hybrid dimensions, overall score, grade,
   findings, proposals, provenance, token usage, and cost.
6. Rejected, unavailable, over-budget, malformed, or uncited output keeps a
   truthful deterministic-only result and an explicit error code.
7. Recovery is bounded to 25 atomic claims per pass, three allocated dispatch
   generations, and three transport attempts per ambiguous generation, with
   generation-specific 90-day idempotency keys and no duplicate model call.
8. Unit and real-SQLite tests cover dispatch failure isolation, leases,
   transition conflicts, replay, concurrency, score caps, unknown IDs,
   malformed output, budget failure, recovery exhaustion, and capability
   negotiation.
9. A fresh real ecommerce report produces one hand-checkable evaluation in
   production without delaying the customer report.
10. Full tests, build, lint, strict Fable 5 review, PR, merge, VPS deployment,
    Trigger deployment, and live verification complete under `AGENTS.md`.

## Rollout order

1. Back up production SQLite and deploy the schema, evaluation endpoints,
   separate token, retention guard, and additive capability advertisement to
   the VPS. No existing app request dispatches evaluation work.
2. Verify migrations, old report behavior, auth separation, and all evaluation
   capabilities on the VPS.
3. Deploy the exact reviewed commit to Trigger with the evaluation worker,
   recovery schedule, and updated report-orchestration task while
   `MARKET_SIGNAL_EVALUATION_DISPATCH_ENABLED=false`. Both the schedule and
   report-orchestration dispatcher must exit without claiming work while this
   gate is false.
4. Inspect a dry-run backlog count, atomically claim one canary through the
   private endpoint, manually trigger that exact evaluation task/generation,
   and verify its persisted result, usage, cost, and customer report latency.
5. Only after the canary passes, set
   `MARKET_SIGNAL_EVALUATION_DISPATCH_ENABLED=true`, redeploy/promote the same
   reviewed source, run one bounded recovery pass, and verify automatic
   dispatch. No historical model work may begin before this step.

## Deferred work

- Owner-only quality dashboard and evaluator cohort view.
- Human-scored golden-set calibration and cross-version agreement checks.
- Independent first-party factual spot checks.
- Failed/interrupted-run evaluations and weekly improvement aggregation.
- Exa/Parallel discovery challenger implementation from Task 085.

## Architecture review record

- Fable 5 was requested first but reported its session limit with a 1:00 AM
  Africa/Cairo reset.
- Under the repository's approved Fable-limit fallback, two strict Codex
  subagent passes blocked the initial scope on intermediate-state recovery,
  permanent Trigger idempotency keys, non-durable post-commit dispatch, mutable
  evaluator inputs, unenforced packet bounds, capability/auth/retention rollout,
  non-atomic dispatch claims, disabled-canary rollout, and a Trigger-start/
  acknowledgement race.
- The design now uses frozen inputs, bounded packets and pricing, generation-
  specific atomic dispatch claims, a task-consumed lease token, non-regressing
  late acknowledgement, an at-most-once judging barrier, separate credentials,
  active-lease retention guards, and a dispatch-disabled canary rollout. A fresh
  strict subagent review returned `SUBAGENT_TASK_090_SCOPE_PASS` with no blocker
  or major finding. Fable 5 remains the required final implementation and merge
  gate after its limit resets.

## Implementation validation record

- The bounded packet, strict judge schema, hybrid scorer, SQLite lifecycle,
  authenticated application route, Trigger HTTP adapter, worker, recovery
  dispatcher, schema migration, orchestration handoff, and retention guard are
  implemented on `codex/bounded-agent-report-judge`.
- `npm test` passes typecheck, the production build, and 455 tests. `npm run
  lint` has no errors and only the two pre-existing `no-img-element` warnings.
- Real SQLite tests cover lease and claim contention across two connections,
  immutable judging, stable same-generation dispatch tokens, persisted outbox
  identity after an idempotent insert conflict, transport and generation
  exhaustion, count-only backlog inspection, and retention reconciliation.
- The first strict implementation review found five P1/P2 issues. All five were
  corrected and regression-tested: generation token rotation, deletion before
  lease reconciliation, conflicted outbox identity, unchecked terminal commit
  acknowledgement, and unbounded backlog counting.
- A second strict pass found three additional P2 issues around report timestamps,
  abandoned dispatch retention, and credential reuse. After fixes and regression
  tests, the fresh review returned `SUBAGENT_TASK_090_CODE_PASS`.
- Production canary evidence, strict Fable 5 implementation PASS, merge, and
  exact-commit VPS/Trigger deployment remain release gates.
