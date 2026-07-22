# Task 069 - Evidence-grounded AI actions

## Problem

The product table's `Next move` is selected from a small deterministic rule set.
Those rules preserve important price and match truth boundaries, but a real
report can repeat the same sentence across many distinct product pairs. The
result reads like static template copy instead of a useful analyst action.

## Outcome

Draft one concise, product-specific recommendation for each accepted pair from
the final enriched evidence. Keep deterministic product identity, price,
currency, variant, billing, and claim gates unchanged. Persist the recommendation
with its evidence references and provenance so saved reports, Arabic views, and
CSV exports remain stable and auditable.

## Accepted design

- Run one bounded batched action-drafting pass after final product enrichment.
- Use `gpt-5.4-mini` by default through strict JSON-schema output.
- Send only bounded product, match, price-verdict, and source facts. Treat all
  crawled text as untrusted data, never instructions.
- Require every AI action to cite at least two enumerated fact keys, including
  at least one fact beyond the two product names.
- Reject drafts with unsupported fact keys, numbers, domains, or proper-noun
  entities; invalid or incomplete drafts fall back per pair to the existing
  deterministic action.
- Preserve `priceComparison`, `priceVerdict`, match verdicts, and all existing
  deterministic vetoes byte-for-byte. AI may phrase an action but may not
  establish or change a fact.
- Save English and Arabic actions, rationale, lever type, evidence keys, model,
  prompt version, and `ai` or `deterministic` source in the report document.
- Show the short localized action in the existing table geometry. Put rationale,
  evidence references, and provenance inside the existing disclosure.
- Add action source to CSV. Never call a model from a client component or report
  view route.
- Bound calls, latency, and failure handling so action drafting cannot prevent a
  report from completing.

## Acceptance criteria

1. Every accepted pair has a non-empty persisted action plan; an AI action is
   used only when all schema and grounding gates pass.
2. Invalid, partial, timed-out, or unavailable model output retains the existing
   deterministic recommendation for the affected pair.
3. AI output cannot add a number, domain, or proper-noun entity absent from its
   enumerated inputs and cannot cite an unknown fact key.
4. Existing price verdicts, direct-delta eligibility, and match assessments are
   unchanged for pinned regression fixtures.
5. English and Arabic action text are saved together. UI selection is locale
   based and does not trigger a model call.
6. The disclosure shows action rationale and whether the source is AI or rules;
   CSV exports `suggested_action_source`.
7. Action planning has a strict request, call, timeout, and total-duration budget
   with visible saved coverage metadata and deterministic fallback.
8. Focused tests cover accepted output, invented facts, partial output, missing
   configuration, route parsing, orchestration ordering, UI provenance, and CSV.
9. Full typecheck, build, tests, and lint pass. A real public-domain report is
   checked before completion.

## Data truth boundary

AI recommendations are recommendations, not observations. Public product pages,
match assessments, and deterministic price logic remain the sources of facts.
The recommendation record stores cited fact keys and its model or rule source;
it never upgrades inferred text into observed evidence.

## Decision record

Fable 5 (`claude-fable-5`) recommended the batched, evidence-cited drafting pass
behind deterministic gates. It rejected per-view generation and free-form
strategy paragraphs because they would create unstable reports, repeated cost,
and unverifiable generic copy.

## Review record

Fable 5 completed an adversarial implementation review on 2026-07-22. The first
review blocked on asymmetric Arabic validation, a sentence-initial entity
bypass, silent truncation after the AI drafting cap, and incorrect model
provenance on deterministic fallbacks. Those four findings were fixed and
covered by regression tests. Fable 5 re-read the updated implementation and
returned `PASS`, with production validation retained as the final pre-merge
gate.

Codex independently verified typecheck, production build, the full 330-test
suite, and lint. Lint reported only the two pre-existing `no-img-element`
warnings in the product/report renderers and no errors; this task introduced no
new lint warning.

## Production validation

Pending exact-commit deployment and a fresh real-domain report.
