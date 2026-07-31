# Task 086 — AI search methods and report-quality evaluation

## Goal

Improve Market Signal through a measured feedback loop:

1. use current AI-native discovery methods instead of treating one search API
   as the complete solution;
2. rate every persisted report using reproducible data-quality checks and a
   bounded agent judge; and
3. turn repeated, evidence-backed report failures into reviewed improvement
   candidates without allowing an evaluator to rewrite production behavior.

This task approves the architecture. Storage, orchestration, owner UI, and live
calibration are separate implementation tasks and PRs.

## What practitioners are doing

Current tool documentation and developer discussions converge on a split stack:

- **AI-native retrieval:** Exa, Parallel, Tavily, Linkup, and similar systems
  accept natural-language objectives and return ranked, agent-oriented context.
- **Crawl and browser fallback:** Firecrawl, Browser Use, Crawl4AI, Playwright,
  and hosted browser agents handle JavaScript, navigation, pagination, and
  extraction after a useful URL is known.
- **Verification and reranking:** builders complain that every provider can
  return SEO pages, low-quality blogs, stale pages, or plausible-looking false
  positives. A separate evidence verifier is therefore more important than
  selecting a larger synthesis model.
- **Provider routing:** practitioners commonly use one service to find URLs and
  another to extract or browse them. No provider is consistently best for
  company entities, product-detail pages, dynamic ecommerce sites, news, and
  structured vertical data at the same time.
- **Hybrid evaluation:** production-evaluation systems combine cheap
  deterministic checks, rubric-based LLM judging, trace or trajectory review,
  and a human-calibrated golden set. Current discussions repeatedly warn that an
  uncalibrated LLM judge rewards polish and shares the evaluated model's biases.

Developer discussions are anecdotal leads, not provider-quality proof. Market
Signal still requires its own real-domain benchmark.

Official and research sources:

- <https://exa.ai/docs/reference/verticals/company>
- <https://docs.parallel.ai/findall-api/entity-search>
- <https://docs.tavily.com/documentation/api-reference/introduction>
- <https://docs.linkup.so/pages/documentation/endpoints/search/overview>
- <https://docs.firecrawl.dev/developer-guides/usage-guides/choosing-the-data-extractor>
- <https://docs.browser-use.com/open-source/customize/integrations/mcp-server>
- <https://www.braintrust.dev/docs/evaluate/score-online>
- <https://arize.com/docs/phoenix/evaluation/llm-evals>
- <https://www.langchain.com/langsmith/evaluation>
- <https://arxiv.org/abs/2506.21506>

Representative practitioner discussions:

- <https://www.reddit.com/r/vectordatabase/comments/1v7gdrk/benchmark_exa_vs_tavily_vs_firecrawl_for_llm/>
- <https://www.reddit.com/r/AI_Agents/comments/1pf9avo/whats_the_best_toolapi_for_web_search_in_an/>
- <https://www.reddit.com/r/bestaitools2025/comments/1rhoiir/is_there_any_agentic_ai_search_that_is_not/>
- <https://www.reddit.com/r/AIQuality/comments/1u9cixx/i_spent_time_studying_ai_agent_evaluation_properly/>
- <https://www.reddit.com/r/AI_Agents/comments/1v92d5e/how_do_you_actually_eval_an_agent_that_generates/>

## Recommended discovery method

Use a bounded retrieval agent with specialized stages:

1. **Observed profile:** first-party crawl creates the business, market, product
   family, region, and language profile.
2. **Discovery planner:** creates a frozen set of entity, category, and product
   objectives. It cannot accept website text as instructions.
3. **Parallel retrieval lanes:** the current OpenAI lane remains the production
   baseline; Exa is the first semantic challenger; Parallel is the synchronous
   entity-search challenger. Results are leads only.
4. **Deterministic admission:** normalize URLs, deduplicate companies, reject
   publishers/directories, enforce region and domain safety, and apply existing
   candidate filters before an AI score can consume crawl budget.
5. **Evidence critic:** a bounded agent checks whether each surviving company
   has cited evidence for regional service, offering overlap, customer overlap,
   and direct competitive status. Positive assertions must cite retrieved result
   IDs.
6. **Targeted browser fallback:** use a browser agent only when a high-ranked,
   first-party page is inaccessible to ordinary HTTP or when required product
   fields are visibly JavaScript-dependent. Browser Use or a self-hosted
   Playwright/Crawl4AI worker is a better fit than running an agent on every
   page. Cache successful site-specific scripts and cap healing attempts.
7. **First-party truth:** only the existing crawler/browser observation can
   establish competitor status, product identity, price, image, availability,
   or ad evidence.
8. **Memory and monitoring:** persist successful retrieval routes, verified
   competitors, source health, and failure classes. Trigger.dev can schedule
   recrawls and change checks without expanding the interactive request path.

This is an ensemble with a verifier, not a vote among generated answers.

## Report evaluation model

Every terminal `complete` or `limited` report receives one versioned evaluation
for the exact persisted report-document hash. The evaluation has separate
scores so a polished but shallow report cannot hide weak evidence:

- **User value (0–100):** whether a customer receives useful competitors,
  product comparisons, pricing or image coverage, and concrete next actions.
- **Evidence integrity (0–100):** whether material claims are source-linked,
  current, regionally coherent, honestly typed as observed/inferred/estimated,
  and free of unsupported certainty.
- **Evidence yield (0–100):** the amount of decision-useful first-party evidence
  observed against fixed product and competitor floors. It is not presented as
  a percentage of an unknowable total market.
- **Presentation utility (0–100):** whether the report prioritizes a small set of
  decisions and explains gaps without data dumping.
- **Overall quality (0–100):** `40% user value + 30% evidence integrity + 20%
  evidence yield + 10% presentation utility`, after deterministic caps.

Compute each component to four decimal places, calculate the weighted total,
apply the lowest deterministic cap, then round half-up to the nearest integer.
The grade bands are A `[90, 101)`, B `[80, 90)`, C `[70, 80)`, D `[55, 70)`,
and F `[0, 55)`.

### Reproducible dimension formulas

All ratios clamp to `[0, 1]`. A `floor(actual, target)` component means
`min(actual / target, 1) * points`. Unknown is handled per component and never
silently removed from a denominator. Unless a component explicitly says
otherwise, a zero denominator earns zero points.

**User value** combines 60 deterministic points and 40 judge points:

- 15: verified competitors, floor 3;
- 15: accepted source-linked product pairs, floor 10;
- 10: distinct competitor domains represented by accepted pairs, floor 3;
- 10: accepted pairs with two observed public prices divided by all accepted
  pairs; zero accepted pairs yields zero;
- 10: recommendations linked to at least one supplied evidence ID divided by
  all recommendations; zero recommendations yields zero;
- 10 judge points: competitor usefulness;
- 15 judge points: commercial usefulness of product comparisons; and
- 15 judge points: specificity and priority of recommended actions.

**Evidence integrity** combines 80 deterministic points and 20 judge points:

- 25: material claims with at least one valid first-party source URL divided by
  all material claims; zero material claims yields zero;
- 15: claims with a valid observed/inferred/estimated/recommended type divided
  by all material claims;
- 15: observed prices, images, products, and companies whose cited record exists
  in the relational snapshot divided by all such observed claims;
- 10: source observations within the configured freshness window divided by all
  dated material sources; no dated sources yields zero;
- 10: accepted competitors with first-party regional evidence divided by all
  accepted competitors; zero accepted competitors yields zero;
- 5: explicit gap states for every unavailable phase divided by unavailable
  phases detected from events; no unavailable phase receives all five points;
- 10 judge points: uncertainty and claim-type honesty; and
- 10 judge points: whether recommendations remain within supplied evidence.

**Evidence yield** is fully deterministic:

- 25: primary products observed, floor 50;
- 20: verified competitors, floor 3;
- 20: rival products observed across verified competitors, floor 100;
- 10: observed rival products with a public price divided by all observed rival
  products; zero rival products yields zero;
- 10: observed rival products with a secure image divided by all observed rival
  products; zero rival products yields zero; and
- 15: accepted source-linked product pairs, floor 10.

These are product-value floors, not market-recall claims. SaaS and agency reports
use a separately versioned non-ecommerce rubric before they can receive an
overall score; until then they receive deterministic evidence-integrity metrics
and status `rubric_unavailable`.

**Presentation utility** combines 30 deterministic points and 70 judge points:

- 15: one to three top actions are present and each is evidence-linked;
- 15: every rendered unavailable phase has a visible gap explanation;
- 25 judge points: prioritization and hierarchy;
- 25 judge points: decision clarity without data dumping; and
- 20 judge points: whether a business owner can identify the top three actions.

If the judge does not return an accepted result, store deterministic components
and `deterministic_score`, but keep all judge-dependent dimension scores,
`overall_score`, and `grade` null. Such rows use `rating_basis =
deterministic_only` and are never compared with `rating_basis = hybrid` rows.
`deterministic_score` is the half-up rounded percentage of deterministic points
earned across the applicable deterministic components, with inapplicable
business-type components excluded and their denominator recorded.
`limited` is a coverage state, not a claim that the report lied. A truthful
limited report can score well on evidence integrity while remaining low in user
value and evidence yield.

## Deterministic profiler

Run code-based checks before any model call. Persist raw counts and formulas:

- terminal status and parseable schema;
- primary products observed;
- verified competitor count and investigation gaps;
- competitor products, public-price coverage, and secure-image coverage;
- accepted product-pair count by verdict and confidence;
- primary and rival source-link coverage;
- recommendation-to-evidence linkage;
- region, language, freshness, and coverage-gap states;
- ad coverage state without treating unavailable ad access as zero activity;
- crawl, discovery, extraction, matching, and persistence failure classes; and
- request, token, latency, and cost telemetry when available.

Hard caps prevent style from overcoming missing substance:

- unsupported material claims: overall at most 30;
- ecommerce report with no accepted competitor: overall at most 45;
- accepted competitors but no defensible product pair: overall at most 55;
- no primary products and no truthful terminal access explanation: overall at
  most 35; and
- invalid or missing report schema: no agent score; evaluation status `failed`.

### Full-fact persistence prerequisite

The current `report_documents.document_json` is a compact presentation snapshot:
catalog blocks are truncated to 40 products and unmatched blocks to 20. The
existing `report_companies`, `report_products`, `report_matches`, and
`report_ads` tables are currently schema-only and are not populated. No
report-level price, image, catalog, or match metric may be computed from the
truncated snapshot.

Before the evaluator can launch, a persistence task must:

1. serialize the full observed company, product, match, and ad facts from the
   orchestration result into the existing relational tables;
2. upload them through idempotent, bounded internal callback chunks keyed by
   `run_id`, record identity, and a fact-manifest hash;
3. store declared totals, persisted totals, truncation state, and failure class
   in a final fact manifest;
4. finalize the customer presentation document independently, so relational
   persistence failure cannot hide a completed report; and
5. create an evaluation only when the manifest is complete. Otherwise create a
   terminal `insufficient_facts` evaluation and a persistence quality signal,
   with no report-level coverage claims.

The compact document remains the renderer input. Relational facts and events are
the profiler input. The evaluator records the fact-manifest hash alongside the
document hash so it cannot grade a different evidence snapshot.

## Agent judge

The bounded judge receives the deterministic profile, the compact persisted
report, enumerated evidence references, and a frozen rubric. Website and report
text are untrusted data, never instructions. The judge may not browse, call
tools, recalculate deterministic metrics, or raise a hard cap.

It scores only semantic dimensions that code cannot reliably grade:

1. Are the selected competitors plausible and useful given the supplied
   first-party evidence?
2. Do product comparisons answer a commercial decision rather than merely show
   similar words?
3. Are recommendations specific, prioritized, and supported by cited report
   facts?
4. Does the report clearly distinguish observation, inference, estimation, and
   missing coverage?
5. Can a business owner identify the top three actions without inspecting raw
   evidence dumps?

The judge returns constrained JSON with dimension scores, evidence IDs, failure
codes, short reasons, and at most three improvement proposals. Every positive
or negative conclusion must cite supplied IDs. Unknown IDs, malformed output,
unsupported numbers, schema violations, uncited assertions, or output evidence
IDs absent from the supplied set reject the agent result and retain the
deterministic evaluation with status `agent_rejected`.

## Independent factual spot checks

The report judge can assess internal quality but cannot prove that the public
web was represented correctly. A separate verification sample therefore runs
on:

- every manually flagged report;
- every report with an unusually high score but low source coverage;
- a deterministic 10% sample of reports below 55 when access was otherwise
  healthy; and
- a deterministic 10% sample of other completed reports.

Automatic spot checks are capped at 20 reports per day and prioritized by
source-integrity risk. Manual flags enter the next available slot rather than
bypassing the daily external-fetch budget.
The deterministic sample uses the first 64 bits of
`SHA-256(evaluation_id + spot_check_version)` modulo 1000; values below 100 are
selected. Store the sampling version and hash prefix for auditability.

The spot-check agent receives at most three material claims and may re-fetch
only their existing first-party URLs. URL handling inherits Task 085 controls:
HTTPS only, no credentials, private or reserved targets rejected before every
request and redirect, bounded response size, domain identity checks, and
untrusted content isolation. It records supported, contradicted, unavailable,
or changed. It cannot discover replacement evidence or modify the report score
directly; contradictions create a critical quality signal and send the report
to human review.

The report judge reserves at most USD 0.02 for one model call. A spot-check row
reserves at most USD 0.03 for bounded fetches and one judge call. Pricing model,
token limits, and reservation version are frozen before dispatch; missing or
stale pricing fails closed. No automatic retries are allowed inside either
budget. Trigger-level retry reuses the idempotent row and cannot make another
model call after a result has been recorded.

## Database design

Add `report_evaluations`:

- `id`, internal `run_id`, `evaluation_type`, `input_hash`,
  `fact_manifest_hash`, `evaluator_version`, and unique
  `(run_id, input_hash, evaluator_version, evaluation_type)`;
- `evaluation_type`: `report` or `run_failure`;
- `status`: `pending`, `dispatch_failed`, `deterministic`, `complete`,
  `agent_rejected`, `insufficient_facts`, `rubric_unavailable`, or `failed`;
- `rating_basis`: `hybrid`, `deterministic_only`, or `none`;
- `overall_score`, `user_value_score`, `evidence_integrity_score`,
  `evidence_yield_score`, `presentation_score`, `deterministic_score`, and
  `grade`; judge-dependent scores and grade are nullable;
- `deterministic_json`, `agent_json`, `findings_json`, and `proposals_json`;
- `model`, `prompt_version`, `pricing_version`, `cost_microusd`, `input_tokens`,
  `output_tokens`, `error_code`, `dispatch_attempts`, `started_at`, and
  `completed_at`; and
- indexes on `(run_id, completed_at)`, `(overall_score, completed_at)`, and
  `(status, completed_at)`.

Add `report_quality_signals`:

- `id`, `evaluation_id`, `run_id`, `primary_domain`, `stage`, `issue_key`,
  `severity`, `evidence_json`, and `observed_at`;
- unique `(evaluation_id, issue_key)`; and
- indexes on `(issue_key, observed_at)` and `(stage, severity, observed_at)`.

Do not duplicate the full report document in either table. Store bounded,
source-linked evidence IDs and formulas.

The current repository has an `expires_at` marker but no implemented deletion
job, so retention is presently indefinite. Evaluations cannot launch in
production until a scheduled purge deletes expired quality signals,
evaluations, ads, matches, products, companies, documents, events, and finally
runs in dependency order, with a bounded retry and audit count. Calibration
examples are not called de-identified: domain-centric reports are inherently
re-identifiable. Any longer-lived calibration copy requires explicit owner
selection, a separate retention policy, and removal of customer-access tokens;
otherwise it expires with the report.

## Execution

1. The application binds the current evaluator version when a row is created,
   never when a worker happens to start. Saving a terminal report creates an
   idempotent `pending` row in the same database batch as the document only when
   the full-fact manifest is complete. Missing facts create
   `insufficient_facts` instead.
2. After the save transaction commits, the internal report route dispatches a
   separate `market-signal-report-evaluation` Trigger.dev task. Its idempotency
   key is `evaluation:<evaluation_id>:<evaluator_version>`, TTL 90 days. Dispatch
   failure updates only the evaluation to `dispatch_failed`; it never changes
   report availability or the successful customer callback.
3. A scheduled recovery task runs every 15 minutes, selects at most 25
   `pending` or `dispatch_failed` evaluations older than five minutes, and
   redispatches each at most three times with the same idempotency key. Older
   unresolved rows become `failed` with `evaluation-dispatch-exhausted`.
4. The Trigger worker has no direct database authority. Authenticated internal
   endpoints expose one bounded evaluation input by evaluation ID and accept an
   idempotent `deterministic` transition or terminal result. The callback rejects evaluator-version,
   input-hash, fact-manifest-hash, or terminal-state conflicts.
5. Deterministic profiling runs first. The judge runs once only when the report
   is structurally valid, the ecommerce rubric applies, and its model/cost
   reservation is available. The worker persists the deterministic state before
   any model call so a retry cannot issue a duplicate call after success.
6. Rows may transition while pending—`pending → deterministic → terminal`—but
   are immutable after any terminal status. Re-evaluation is an explicit
   owner-only action that creates a new row with a new evaluator version or
   input hash; terminal reports are not re-saved.
7. Failed and interrupted report runs create `evaluation_type = run_failure`
   rows from the terminal run/events hash. They run deterministic profiling only
   and emit normalized crawl, dispatch, worker, or persistence signals without
   an LLM cost.
8. The customer report does not display the internal rating initially. An
   owner-only quality view shows scores, formulas, evidence, failure stage,
   rating basis, evaluator version, cost, and calibration state.

Thresholds, aggregates, and cohorts use matching `evaluation_type`,
`rating_basis`, evaluator version, business-type rubric, and terminal status.
Deterministic-only, agent-rejected, failed, and hybrid rows are never mixed in a
single score distribution.

## Improvement feedback loop

Never let the judge edit prompts, thresholds, crawler policy, or production code
automatically. Aggregate normalized `issue_key` values weekly:

- a proposal becomes `candidate` only after at least five affected reports and
  three distinct domains within 30 days;
- critical source-integrity contradictions bypass the count threshold but still
  require human review;
- each candidate links example evaluations, affected stages, median score loss,
  estimated user impact, and a reproducible offline test set;
- accepted candidates become normal repository tasks and follow the existing
  branch, tests, Fable review, PR, merge, deployment, and real-domain validation
  workflow; and
- compare before/after cohorts using the same evaluator version. A new judge
  version cannot be used to claim an implementation improved itself.

Evaluator score movement is diagnostic evidence, never sufficient acceptance
proof. Every improvement must also pass at least one predeclared
judge-independent outcome:

- human re-scoring of at least five blinded golden or production examples;
- lower first-party spot-check contradiction rate;
- higher deterministic price, image, source-link, or accepted-pair yield on the
  same fixed corpus; or
- improved user usefulness rating without a worse evidence-integrity or
  contradiction rate.

The independent outcome and minimum effect are fixed in the task before code is
changed. This prevents implementation work from optimizing only for the visible
judge rubric.

User feedback remains a separate signal. Correlate it with evaluator dimensions
to discover miscalibration; never train the judge directly on raw user ratings.

## Calibration and anti-gaming

- Build a human-scored golden set of at least 30 reports across ecommerce,
  SaaS, agencies, complete runs, limited runs, and known failure cases.
- Require two human ratings on at least ten seed reports and resolve material
  disagreement before trusting the rubric.
- Measure per-dimension agreement and hard-cap violations whenever the judge
  model or prompt changes.
- Keep evaluator model and prompt versions independent from the report-producing
  models.
- Include deliberately polished but unsupported reports and ugly but well-
  sourced reports in the calibration set.
- Run deterministic checks in CI; run the agent judge on the golden set before
  an evaluator release; and sample production drift weekly.

## Tooling decision

Build the first evaluator inside the existing SQLite/D1 and Trigger.dev stack.
Do not add Braintrust, LangSmith, or Phoenix as a runtime dependency yet. They
are useful references and later observability options, but the product already
has durable reports, phase events, source records, and background execution.
An external platform would not replace the Market Signal-specific rubric or
database feedback loop.

For discovery, benchmark the Task 085 Exa/Parallel plan. Add a browser-agent
fallback experiment only for a measured corpus of pages where ordinary HTTP
misses visible product fields. Do not run browser agents across every catalog.

## Acceptance criteria

1. Research distinguishes retrieval, extraction/browser automation,
   verification, and evaluation rather than selecting one tool for all work.
2. Every terminal report can receive an idempotent, versioned evaluation without
   delaying or modifying the customer report.
3. Deterministic metrics, agent judgments, factual spot checks, and user
   feedback remain visibly separate.
4. Missing coverage cannot be converted into zero activity or false certainty.
5. Scores include formulas, evidence references, hard caps, model/prompt version,
   cost, and status.
6. Repeated failures create reviewed task candidates; no evaluator can
   autonomously change production behavior.
7. Human calibration and cross-version comparison rules prevent evaluator drift
   from being mislabeled as product improvement.
8. Full relational fact persistence, evaluation recovery, failed-run signals,
   and expiry purge are explicit launch dependencies rather than assumed current
   behavior.
9. Every score component, unknown-value rule, rounding rule, hard cap, and grade
   band is reproducible from a matching fact manifest and evaluator version.
10. Strict Fable 5 architecture review returns PASS before merge.

## Review record

- A verified `claude-fable-5` high-effort architecture review returned
  `REPORT_EVALUATION_BLOCK`. It identified undefined score inputs, an invalid
  assumption that the current relational report tables were populated,
  incomplete dispatch and recovery semantics, missing failed-run signals,
  unknowable market-coverage denominators, evaluator Goodhart risk, inaccurate
  retention claims, and unsafe mixing of hybrid and deterministic-only scores.
- The design now defines every score component and grade rule, makes full-fact
  persistence and purge explicit prerequisites, adds idempotent Trigger recovery
  and authenticated callbacks, captures failed/interrupted runs without model
  cost, replaces market coverage with fixed-floor evidence yield, requires
  judge-independent improvement proof, and separates every rating basis.
- A new verified `claude-fable-5` high-effort session re-read the revised task
  against the repository and returned `REPORT_EVALUATION_PASS` with no blocker
  or major finding. This PASS approves the architecture only; implementation,
  calibration, deployment, and real-report validation remain separate tasks.
