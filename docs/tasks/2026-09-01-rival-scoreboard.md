# Rival experience scoreboard

## Outcome

Fresh direct-search reports compare the submitted company with the rival
domains that actually produced accepted product comparisons. Every displayed
score uses the existing public experience-benchmark formulas; unavailable
rivals remain visible as not assessed instead of receiving a synthetic zero.

## Root cause

The report UI already renders every domain persisted in the
`experience-benchmark` block. The current direct-product-search crawl ends
after collecting the primary catalog, while rival domains are learned later
from accepted product comparisons. As a result, the benchmark block reaches
the report with only the primary company.

## Scope

- Select at most five unique rival domains from published accepted comparison
  rows, ordered by accepted comparison count and then canonical domain.
- Require at least one accepted published comparison; the comparison itself is
  already the report's evidence that the rival belongs in this report.
- Run a bounded, non-search, non-model crawl for each selected rival after the
  comparison result is fixed.
- Apply the same benchmark scorer and methodology version to primary and rival
  evidence.
- Checkpoint the bounded rival benchmark result so task retries do not repeat
  completed rival crawls.
- Merge successful scores and explicit unavailable states into the existing
  benchmark block before terminal persistence.
- Show when each company was assessed and explain why an unavailable rival has
  no score.
- Preserve immutable historical reports; they are not retroactively changed.

## Data and trust boundaries

- Scores are derived only from public pages returned by the existing protected
  crawl endpoint.
- Canonical-domain validation, outbound request policy, robots handling,
  redirect limits, and page limits remain owned by the crawler.
- Missing evidence is `null`, never zero.
- The benchmark does not claim Core Web Vitals, subjective visual quality, or a
  completed checkout.
- Rival benchmark collection performs no external search and no AI/model call.
- Each row retains source URLs, observation time, sample sizes, formula text,
  metric version, availability state, and a bounded failure reason.

## Acceptance criteria

1. A fresh direct-search report with accepted comparisons across rival domains
   persists the primary plus up to five rival rows in the market scoreboard.
2. Rival selection is deterministic and based on accepted published
   comparisons, not arbitrary discovery candidates.
3. Every measured row uses `experience-v1` and exposes its own assessed time.
4. An unavailable, parked, blocked, or failed rival renders as **Not assessed**
   with null metric values and a concise reason.
5. A retry reuses an exact-input durable checkpoint and does not repeat already
   completed rival benchmark crawls.
6. Rival benchmarking cannot change product comparisons, prices, entitlements,
   report ownership, or the primary crawl result.
7. Typecheck, build, lint, automated tests, strict review, and one fresh public
   production report pass before completion is claimed.

## Product and architecture review

Verified Claude Fable 5 (`claude-fable-5`) approved the post-comparison bounded
crawl boundary on 2026-09-01 with required safeguards: pin the scorer and crawl
configuration, persist per-domain provenance and null reasons, bound retries
and latency, validate domains through the existing crawler, and expose each
assessment date. The implementation keeps this work inside the background
report lifecycle so the completed report is internally consistent, while a
durable checkpoint prevents repeated work on task replay.

## Validation

- `npm run lint` — passed with one pre-existing `next/no-img-element` warning
  in `app/components/product-design-lab.tsx` and no errors.
- `npm run typecheck` — passed.
- `node --test --test-reporter=dot tests/experience-benchmark.test.mjs
  tests/trigger-report-orchestration.test.mjs` — passed.
- `npm test` — passed the production build and all 1,269 tests with zero
  failures.
- Strict exact-head Fable review, PR state, deployments, and production-domain
  validation remain pending.
