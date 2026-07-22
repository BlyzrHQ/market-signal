# Task 071 - Luna action model

## Problem

The evidence-grounded product action planner still defaults to
`gpt-5.4-mini`. The user requested Luna for this AI recommendation layer. A
blanket model replacement would also change discovery, product matching, ads,
domain recovery, and the legacy market brief, whose persisted evidence and
acceptance baselines were established with their current models.

## Outcome

Use OpenAI's documented `gpt-5.6-luna` model by default for product action
drafting only. Keep every other model default unchanged, preserve explicit
runtime overrides, and retain deterministic recommendations whenever the Luna
call is unavailable, late, malformed, or rejected by the evidence gates.

## Accepted design

- Change only the action planner's internal default to `gpt-5.6-luna`.
- Preserve model resolution order: explicit option,
  `MARKET_SIGNAL_ACTION_MODEL`, `MARKET_SIGNAL_MATCH_MODEL`, then Luna.
- Document `MARKET_SIGNAL_ACTION_MODEL=gpt-5.6-luna` for deployment so an
  explicit matching-model value does not unintentionally override the action
  model.
- Keep the Responses API request, low reasoning effort, strict JSON Schema,
  output-token limit, timeouts, total budget, validation, provenance, and
  deterministic fallback unchanged.
- Resolve the configured action model through one shared helper so both normal
  planning and Trigger transport-failure metadata record the same model.
- Do not migrate matching, discovery, ads, domain recovery, or the legacy market
  brief in this task. Each requires its own quality and real-domain benchmark.

The model slug and request shape follow OpenAI's current
[GPT-5.6 migration guidance](https://developers.openai.com/api/docs/guides/latest-model#update-api-and-model-parameters)
and [Structured Outputs guidance](https://developers.openai.com/api/docs/guides/structured-outputs).

## Acceptance criteria

1. With no action or match model override, action-planning metadata records
   `gpt-5.6-luna`.
2. Explicit, action-specific, and inherited matching-model overrides retain
   their existing precedence.
3. Requests use the Responses API with `reasoning.effort=low`,
   `max_output_tokens`, and strict `text.format` JSON Schema.
4. Missing credentials, timeouts, transport errors, incomplete output, and
   schema or grounding rejection still retain deterministic actions and visible
   gaps within the existing budgets.
5. Matching, discovery, ads, recovery, and market-brief model defaults do not
   change.
6. Focused tests, full tests, typecheck, production build, and lint pass.
7. When a runtime key is available, one real Luna smoke call returns a
   schema-valid response within the existing 12-second request timeout. A fresh
   public-domain report then confirms saved Luna provenance without model drift
   in the evidence layers.

## Data truth boundary

Luna drafts recommendations from enumerated saved facts. It cannot establish or
change product identity, competitor discovery, prices, currencies, match
verdicts, ad observations, or confidence. Rejected output remains visibly
deterministic.

## Decision record

Fable 5 (`claude-fable-5`) returned `PASS` for a planner-only migration and
would block a fleet-wide replacement. It identified the action planner as the
safest first mover because it is advisory, separately configurable, visibly
provenanced, and protected by deterministic fallbacks. It required explicit
deployment configuration, request-shape compatibility checks, timeout/fallback
regressions, and a live Luna smoke before merge.

## Review record

Fable 5's first implementation review returned `PASS` with two low-severity
robustness notes: literal Luna assertions could inherit a developer's exported
model variables, and Trigger's outer transport-failure fallback stamped the
compile-time default instead of the configured model. Both notes were fixed.
The default test now isolates environment state, request-shape coverage passes
an explicit Luna model, and normal planning plus orchestration fallback share
the same model resolver. Focused `36/36` planner/orchestration tests and the
full validation gate passed after those corrections. Strict re-review is
complete: Fable 5 verified both fixes and returned `TASK 071 RE-REVIEW: PASS`
with no blocker. Its environment required approval to rerun commands, so this
review remains a static code review; Codex's independent validation results are
the executable test evidence.

## Validation

- Focused action-planner tests: `14/14` passed.
- Full repository gate: typecheck passed, production build passed, and `341/341`
  tests passed.
- Lint passed with zero errors and the two pre-existing `no-img-element`
  warnings in the product/report renderers.
- OpenAI documentation confirms `gpt-5.6-luna`, low reasoning effort,
  `max_output_tokens`, and strict `text.format` Structured Outputs on the
  Responses API. The local worktree has no `OPENAI_API_KEY`, so the real Luna
  smoke remains a hosted pre-merge gate rather than being represented as local
  validation.

Pending strict implementation review, real Luna smoke, exact-commit deployment,
and fresh public-domain report.
