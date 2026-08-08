# Task 120 — Automatic report agent evaluation

## Goal

Run one bounded, evidence-grounded agent evaluation after every terminal report
whose full fact manifest passed deterministic profiling. Persist a concise
breakdown of what the report did well, what reduced its usefulness, and at most
three concrete improvement proposals without delaying or changing the customer
report.

This task implements the automatic judge and its durable dispatch/recovery
boundary as an **internal pilot**. Production dispatch remains disabled until
Tasks 121 and 122 add separate human adjudication, owner visibility, feedback
delivery, and the Task 086 calibration prerequisites. Model output can never be
mistaken for a human decision or an authorized code change.

## Product contract

- The deterministic profiler remains the authority for counts, coverage,
  formulas, hard caps, and evidence existence.
- The agent receives only the persisted compact report, deterministic profile,
  and a bounded catalog of evidence IDs. Report and website text is untrusted
  data, never instruction text.
- The agent cannot browse, call tools, alter deterministic metrics, raise a hard
  cap, modify the report, or modify production code.
- Every strength, weakness, score reason, and proposal must cite supplied
  evidence IDs. Unknown IDs, missing citations, malformed JSON, or out-of-range
  scores reject the agent result.
- The result contains explicit `strengths`, `weaknesses`, and `proposals`, each
  with a stable issue key, a short owner-readable explanation, and evidence IDs.
- The agent may request human judgment only by returning a bounded uncertainty
  code and one specific question. Until Task 121 persists and presents that
  request separately, the evaluation remains provisional and
  `deterministic_only`; it cannot receive a final hybrid grade.
- A rejected, unavailable, or over-budget agent never erases deterministic
  results. The evaluation remains truthful as `deterministic_only`.

## Execution

1. A terminal report is saved and deterministically profiled exactly as today.
2. When the internal-pilot flag is enabled, the application dispatches
   `market-signal-report-evaluation` only when the bound evaluation is in
   `deterministic` state and the ecommerce rubric applies.
3. Dispatch attempt `n` uses
   `evaluation:<evaluation_id>:<evaluator_version>:dispatch:<n>` with a 90-day
   idempotency TTL. A stale dispatch receives a new attempt key because Trigger
   may otherwise return the original stuck run. The payload carries `n`; only
   the current database attempt may reserve the call, so concurrent old/new
   workers cannot both reach the provider. Dispatch failure changes only
   evaluation telemetry.
4. The Trigger worker fetches one authenticated, bounded evaluation input from
   the application. A CAS transition assigns a random reservation owner and a
   UUID `X-Client-Request-Id` before the call. The contract is deliberately
   **at-most-once**, not exactly-once: a transport timeout or crash after the
   provider may have accepted the request terminates as `call_outcome_unknown`
   and is never called again automatically. This can leave a report without an
   agent judgment, but it cannot silently double-charge it.
   The model request timeout is 90 seconds. The reservation watchdog is ten
   minutes, so it never races an ordinarily in-flight request. Any callback
   received after a terminal watchdog transition is rejected with an immutable
   409 conflict and cannot overwrite the terminal row.
5. The worker calls the OpenAI Responses API once with a strict JSON schema,
   fixed prompt version, fixed model, token ceiling, timeout, and a maximum
   reserved cost of USD 0.02.
6. The application revalidates the complete result and atomically persists the
   strengths, weaknesses, proposals, model/prompt/pricing versions, token counts,
   estimated cost, and terminal status against the exact report-document and
   fact-manifest hashes. Hybrid scores and grade are persisted only when
   `humanReview` is null.
7. A 15-minute scheduled recovery pass first re-runs deterministic profiling for
   at most 25 `pending` evaluations older than five minutes, using the existing
   binding CAS; profiling errors terminate through Task 088's `failed` path. It
   then redispatches unreserved `deterministic` or `dispatch_failed` rows. Stale
   `dispatching` rows older than five minutes become `dispatch_failed`; the next
   database dispatch attempt increments `n` and therefore uses a new
   `dispatch:<n>` Trigger key. Stale `reserved` rows older than ten minutes
   become `call_outcome_unknown` without another call. Three failed dispatches
   terminate as `evaluation-dispatch-exhausted`.

### State and storage contract

The full state set is:

- non-terminal: `pending`, `deterministic`, `dispatching`, `dispatch_failed`,
  and `reserved`;
- terminal: `complete`, `agent_rejected`, `needs_human_review`,
  `call_outcome_unknown`, `failed`, `insufficient_facts`, and
  `rubric_unavailable`.

The legal agent lifecycle is:

`deterministic -> dispatching -> reserved -> complete | agent_rejected |`
`needs_human_review | call_outcome_unknown`.

`pending -> deterministic`; `dispatching -> dispatch_failed -> dispatching` is
allowed up to three dispatch attempts before terminal `failed` with
`error_code=evaluation-dispatch-exhausted`. Entering `dispatching` increments
`dispatch_attempts` and records `dispatch_started_at`; successful reservation
records `reserved_at`. A stale dispatch transition records its failure time; a
terminal transition records `completed_at`. No other backward transition is legal. CAS predicates
bind evaluation ID, evaluator version, input hash, fact-manifest hash, current
status, current dispatch attempt, and reservation owner. `deterministic_at` records profiling completion;
`completed_at` is empty until a terminal evaluation state.

Migrate the evaluation table with `deterministic_at`, `dispatch_started_at`,
`dispatch_token`,
`dispatch_failed_at`, `watchdog_expired_at`,
`reservation_id`,
`reservation_owner`, `reserved_at`, `client_request_id`, `provider_response_id`,
`provider_request_id`, `usage_status`, `reserved_cost_microusd`, and nullable
actual input, cached-input, output-token, and cost fields. Existing zero defaults
must not represent unknown usage. `usage_status` is one of `not_called`,
`reserved`, `known`, or `unknown`.

Existing `ecommerce-deterministic-v1` rows are not upgraded or automatically
called. Migration backfills `deterministic_at` from their existing
`completed_at`, sets `usage_status=not_called`, and leaves nullable usage fields
null while preserving their historical completion timestamp. New reports bind
`ecommerce-agent-v1`, which contains deterministic profiler version
`ecommerce-deterministic-v1`. Historical agent evaluation is a later explicit
owner action that creates a new row; it never mutates the old identity.

One immutable agent evaluator version binds the deterministic rubric, model
snapshot, developer prompt, output schema, evidence projection and selection,
and pricing versions. A change to any of them creates a new evaluation identity.

### Strict output contract

The Responses request uses a recursively closed JSON Schema: every object has
`additionalProperties: false`, every property is required, and absence is
represented by an explicit empty array or null. The root contains:

- `scores` contains exactly eight required score objects. Every score object is
  `{ score, reason, evidenceIds }`, with a 1–200 character reason and one to five
  evidence IDs. Fields and integer ranges are:
  `competitorUsefulness` 0–10, `productComparisonUsefulness` 0–15,
  `recommendationSpecificity` 0–15, `uncertaintyHonesty` 0–10,
  `recommendationGrounding` 0–10, `prioritizationHierarchy` 0–25,
  `decisionClarity` 0–25, and `topActionsIdentifiable` 0–20;
- `strengths`, `weaknesses`, and `proposals`, each capped at three items;
- every item has an enumerated issue code, subject kind (`report`, `company`,
  `product`, `match`, or `recommendation`), subject ID, a 1–240 character
  explanation, one to five non-empty evidence IDs, and no free-standing numeric
  metric. The closed issue-code set is `useful_competitors`,
  `weak_competitor_fit`, `useful_product_pairs`, `weak_product_pairs`,
  `actionable_recommendations`, `generic_recommendations`, `honest_uncertainty`,
  `unsupported_certainty`, `clear_priorities`, `data_dumping`, `evidence_gap`,
  `presentation_clarity`, `improve_competitor_verification`,
  `improve_product_matching`, `improve_price_coverage`,
  `improve_image_coverage`, `improve_recommendation_specificity`,
  `improve_evidence_linking`, `improve_gap_explanation`, or
  `improve_information_hierarchy`. Strengths allow only
  `useful_competitors`, `useful_product_pairs`, `actionable_recommendations`,
  `honest_uncertainty`, `clear_priorities`, and `presentation_clarity`;
  weaknesses allow only `weak_competitor_fit`, `weak_product_pairs`,
  `generic_recommendations`, `unsupported_certainty`, `data_dumping`, and
  `evidence_gap`; proposals allow only the eight `improve_*` codes;
- `humanReview`, either null or one object containing an uncertainty code from
  `conflicting_evidence`, `subjective_usefulness`, `insufficient_context`, or
  `suspected_factual_error`, plus one 1–240 character question and evidence IDs.

The deterministic application mapping adds the first three score values to the
60 user-value points, the next two to the 80 integrity points, and the final
three to the 30 presentation points. Evidence yield stays deterministic. It
then applies Task 086 weights and the lowest persisted hard cap.

Evidence and subject IDs must match `[a-z][a-z0-9:_-]{0,119}`. Outcome mapping
is explicit:

- complete, valid schema/semantics/usage, `humanReview=null` -> `complete`;
- complete and valid with human request -> `needs_human_review`;
- refusal, incomplete/truncated output, malformed JSON, unknown fields,
  duplicate/disallowed issue codes, out-of-range scores, inapplicable evidence,
  unsupported numeric prose, absent total usage, or missing provider response ID
  -> `agent_rejected`;
- an explicit provider HTTP error -> `agent_rejected` with the bounded status
  class and unknown usage, with no retry;
- network error, transport timeout/abort, worker crash after reservation, or
  reservation watchdog expiry -> `call_outcome_unknown`, with no retry; and
- late, mismatched, duplicate-different, or terminal callbacks -> 409 without a
  state change.

### Evidence and injection boundary

The application generates at most 48 deterministic, typed evidence records.
Each record has a server-generated ID, type (`company`, `product`, `match`,
`recommendation`, `gap`, or `presentation`), subject IDs, domain, source URL when
applicable, and one allowlisted text projection capped at 320 characters.
Selection is stable:
all hard-cap and gap records first, then accepted matches across distinct rival
domains, then deterministic-score losses, then stable ID order. Duplicate facts
are removed before selection.

Every evidence record has explicit nullable `companyId`, `productId`, `matchId`,
and `recommendationId` relationship fields; unrelated fields are null. Semantic validation requires each citation to match the conclusion subject and
an allowed evidence type; ID membership alone is insufficient. Score evidence
types are: competitor usefulness=`company|gap`; product usefulness=`match|product`;
recommendation specificity/grounding=`recommendation|match|product|company`;
uncertainty honesty=`gap|company|product|match`; and presentation fields=
`presentation|recommendation|gap`. For a non-report subject, at least one cited
record must contain that exact subject ID in the corresponding typed relationship
field. The exhaustive issue-code evidence matrix is:

- `useful_competitors`, `weak_competitor_fit`,
  `improve_competitor_verification` -> `company|gap`;
- `useful_product_pairs`, `weak_product_pairs`, `improve_product_matching`,
  `improve_price_coverage`, `improve_image_coverage` -> `product|match`;
- `actionable_recommendations`, `generic_recommendations`,
  `improve_recommendation_specificity`, `improve_evidence_linking` ->
  `recommendation|match|product|company`;
- `honest_uncertainty`, `unsupported_certainty`, `evidence_gap`,
  `improve_gap_explanation` -> `gap|company|product|match`; and
- `clear_priorities`, `data_dumping`, `presentation_clarity`,
  `improve_information_hierarchy` -> `presentation|recommendation|gap`.

Numeric claims
are forbidden in agent prose unless copied exactly from the cited projection.
The frozen policy is sent only as developer instructions. The user-data envelope
contains only: report ID/domain/status; deterministic raw counts/components/caps;
up to 48 evidence records; headline (160 chars); summary (600); up to three
actions (240 each); up to eight gaps (240 each); up to eight section labels and
summaries (60/240 each); and up to twelve navigation labels (60 each). Selection
uses source order followed by stable ID, strings collapse whitespace, and each
array truncates at its declared limit before the whole canonical JSON envelope
is byte-checked. No other compact-report field is sent. The envelope is never
interpolated into developer text. No tools are declared, no URL is fetched,
and model-billed input is capped deterministically. Before reservation, measure
the UTF-8 bytes of the exact serialized developer instructions, strict JSON
Schema, and canonical user envelope together. If their sum exceeds 16,000
bytes, evidence records are removed from the end of the stable priority order
and the exact payload is remeasured after each removal. Fixed projection fields
are never dynamically reworded or truncated beyond their declared field limits.
If the request without evidence still exceeds the limit, evaluation fails closed
before reservation and makes no model call.
Adversarial fixtures place
instructions in product names, descriptions, recommendations, and company text.

## Scoring

Use the frozen Task 086 rubric:

- user value: deterministic 60 points plus agent 40;
- evidence integrity: deterministic 80 points plus agent 20;
- evidence yield: deterministic 100 points;
- presentation utility: deterministic 30 points plus agent 70;
- overall: 40% user value, 30% integrity, 20% yield, 10% presentation;
- apply the lowest deterministic hard cap before half-up rounding and grading.

The implementation must use the deterministic component numerators already
persisted by Task 088. It must not infer missing deterministic points from prose.

## Privacy, safety, and cost

- Never send credentials, cookies, internal callback tokens, customer access
  tokens, raw HTML, or more than the bounded evidence catalog to the model.
- Never log prompt contents or customer report text in Trigger or application
  logs.
- Pin `gpt-5.4-mini-2026-03-17`, at most 1,200 output tokens, and at most
  16,000 UTF-8 input bytes including instructions. Pricing version
  `openai-2026-08-09` uses USD 0.75 per million uncached input tokens, USD 0.075
  per million cached-input tokens, and USD 4.50 per million output tokens. The
  conservative reservation treats every input byte as one uncached token,
  producing a maximum below USD 0.02.
- Calculate actual micro-USD from API-reported input, cached-input, and output
  token fields. Validate `0 <= cached_input_tokens <= input_tokens`.
  `uncached_input = input_tokens - cached_input_tokens`; a missing
  cached detail is conservatively zero. Reasoning tokens are a subset of
  `output_tokens` and are not added again. Round the final aggregate up to the
  next micro-dollar. A response missing total input or output usage is rejected
  with `usage_status=unknown` and nullable actual cost, never zero.
- Evaluations expire with their source report under the existing retention job.

## Acceptance criteria

1. Every newly completed eligible internal-pilot report creates exactly one
   agent-evaluation attempt without adding latency to report availability; an
   uncertain provider outcome is visibly terminal rather than retried.
2. Retries, duplicate callbacks, and recovery cannot create a second reserved
   model call or overwrite a terminal evaluation.
3. A valid result without a human request persists a visible good/bad/proposals
   breakdown, versioned hybrid scores, citations, token usage, and bounded cost.
   A valid result with a request persists the same agent breakdown and usage as
   `needs_human_review`, but all hybrid score and grade columns remain null,
   `rating_basis=deterministic_only`, and `completed_at` records the terminal
   model attempt. Task 121 appends a separate human record and never rewrites the
   model payload.
4. Invalid or unsupported output is rejected and deterministic scoring remains
   available with an explicit failure code.
5. Ineligible, incomplete, non-ecommerce, or unconfigured reports fail closed
   without an API charge.
6. Unit and integration tests cover schemas, evidence-ID rejection, prompt
   injection isolation, scoring and hard caps, idempotency, dispatch failure,
   recovery, timeout, and cost guards.
7. A real public-domain pilot report completes and stores a source-linked
   strengths, weaknesses, and proposals breakdown before this task is called
   complete. General production dispatch remains disabled until Tasks 121 and
   122 and the declared Task 086 calibration gates are complete.
8. Strict Fable 5 review returns PASS; Codex independently verifies tests,
   deployment, and the real report before Fable merges the PR.

## Follow-up tasks

- Task 121: separate persisted human-review requests, owner queue, and immutable
  human labels.
- Task 122: current-Codex-task monitor that reports new findings and asks the
  owner only the specific unresolved human question.
- Later: independent factual spot checks and weekly repeated-issue candidate
  aggregation from Task 086.
