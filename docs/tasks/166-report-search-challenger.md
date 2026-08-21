# Task 166 — Independent report search challenger

## Problem

Market Signal can publish accurate, source-linked comparisons while still
missing alternatives that a customer can find with an ordinary product search.
The latest bounded MyJam report assessed 20 products and published 11 direct
price comparisons, but every published row came from one rival domain. Price
precision is therefore stronger than competitor and product recall.

The current report evaluator cannot detect this gap because it is deliberately
forbidden from browsing and receives only facts already found by the report.

## Product decision

Add an independent, post-report search challenger. It samples the primary
products with the weakest published coverage, searches outside the report's
known sources, verifies candidate product pages through the existing public-page
and price-integrity boundary, and persists a recall-oriented comparison without
changing the customer report.

The challenger is evidence for evaluation, not a source of automatic report
claims. Search snippets alone never count as a priced comparison. A missed
result counts only after its public page passes market, identity, robots,
redirect, supported-currency, and finite-positive-price checks.

## Required behavior

1. Select at most five primary products with zero or one published comparison,
   in stable order with product-family diversity.
2. Run bounded independent product queries that do not reuse the report's
   accepted competitor list as an allowlist.
3. Exclude the primary domain, known report URLs, marketplaces, search pages,
   duplicate canonical URLs, and unsupported public sources.
4. Verify candidate product pages with existing SSRF, robots, redirect, market,
   identity, and price-integrity controls.
5. Persist searched products, candidate and verified counts, missed priced
   pages, missed competitor domains, a recall proxy, root-cause counts, source
   URLs, provider usage, versions, and terminal status against the exact run and
   fact-manifest identity.
6. Surface the challenger summary to the report evaluation feedback loop. It
   must never mutate report companies, products, matches, recommendations, or
   presentation.
7. Use an at-most-once paid search reservation with bounded retries only before
   the provider call. The conditional reservation write must be re-read before
   work is authorized. Unknown call outcomes are terminal and never retried.
8. Run for every new eligible terminal report behind a server-owned kill switch;
   historical reports are not silently backfilled.

## Acceptance criteria

- Unit tests cover sampling, query construction, source admission, duplicate and
  known-source exclusion, price/market validation, recall math, root-cause
  classification, cost accounting, idempotency, callback binding, and fail-closed
  behavior.
- Full typecheck, build, tests, lint, Trigger deployment, and VPS deployment pass.
- One fresh MyJam production report stores a terminal challenger record.
- The live challenger either identifies additional verified UK product pages
  with positive GBP prices or records a specific bounded no-result reason; it
  never treats a search snippet as verified evidence.
- Published report facts remain byte-for-byte bound to their original manifest,
  and no challenger candidate appears in the customer report automatically.
- Strict exact-head reviewer approval is required before merge.

## Data and cost boundaries

- Public sources only; no browser session, cookies, private APIs, or Google UI
  scraping.
- Search and page text is untrusted data and is never interpolated into system or
  developer instructions.
- Candidate URLs and evidence are bounded, canonicalized, and stored with
  observation timestamps.
- Unknown cost is never recorded as zero. A daily or per-run budget breach
  suppresses future challenger launches without discarding completed feedback.
- The USD 0.10 UTC-day ceiling introduced by this task is enforced again in the
  conditional reservation write. Completed known cost and in-flight reserved
  cost are counted; any completed unknown cost closes the budget for that day.

## Architecture review

An independent Claude architecture review recommended a sibling post-report
Trigger task instead of adding browsing to the existing no-tools judge or
blocking the customer report pipeline. The implementation follows that
boundary: one immutable challenge row per report, one bounded provider
reservation, source-backed URLs only, application-side page/identity/market/
price verification, and delivery through the existing evaluation outbox.

The review highlighted residual search-index correlation, price volatility,
robots gaps, cost creep, and sampling bias. These remain explicit limitations
in the persisted verification gaps and bounded sample.

The maximum reservation is USD 0.06 per challenge: up to five versioned USD
0.01 web-search-call allowances plus measured model tokens. Transport-unknown
outcomes are terminal and are not retried as paid work.

Pricing was re-verified on 2026-08-21. OpenAI's official API pricing lists web
search at USD 10 per 1,000 calls (USD 0.01 per call). The model-token rates are
the existing provider-contract rates documented by Task 126 and used by the
current report evaluator: USD 0.20/M input, USD 0.25/M cache-write input, USD
0.02/M cached input, and USD 1.20/M output. Sources:
<https://platform.openai.com/pricing> and
`docs/tasks/126-evaluation-provider-contract-fix.md`.

## Exact-head review remediation

Fable 5's review of head `8a82d4b7acd8a933d563c5f9fdaafe2fc4b43f2b`
returned blockers. The follow-up change:

- verifies the conditional reservation winner before authorizing a provider
  call and atomically rechecks the UTC-day budget including in-flight work;
- preserves canonical input and budget provenance on failed callbacks;
- requires provider response identity and known usage before candidate
  verification;
- identifies search-challenge feedback with its evaluation type and evaluator
  version;
- expands package typecheck coverage to the callback route and all challenger
  task files; and
- adds lifecycle tests for reservation races, daily budget closure, callback
  binding, exclusions, recall, cost, provenance, and category-diverse sampling.

The remediated exact head still requires a fresh strict Fable 5 review before
the PR can be marked ready or merged.
