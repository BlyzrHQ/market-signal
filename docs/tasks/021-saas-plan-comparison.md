# Task 021: First-party SaaS plan comparison

## Problem

The strict version 27 panel rated Linear and Buffer poorly because the product
comparison layer extracted marketing headings such as `Social media` and
`Plan and navigate from idea to launch` instead of named plans with prices.
Those rows are attributable but do not help a founder decide how their offer
compares with ClickUp, Asana, Later, or another direct SaaS competitor.

## Outcome

- Prioritize public `/pricing` and `/plans` pages in the bounded crawl.
- Extract named first-party plan cards from pricing-page headings and nearby
  public price context.
- Record billing period and observable unit basis such as per-user or
  per-channel without inventing missing terms.
- Match different plan names by comparable tier (`free`, `entry`, `team`, or
  `enterprise`) instead of by shared marketing words.
- Produce exact price deltas only when currency, billing period, observable
  billing commitment, and unit basis are aligned; otherwise show a
  billing-alignment gap.
- Keep ordinary feature/capability extraction as a cited fallback.

## Data boundaries

- A plan must come from the company's own public pricing or plans page.
- Prices must occur in the same bounded plan section as the plan name.
- `Contact sales` remains an observed transparency state, never an estimated
  price.
- Annual totals, monthly prices, per-user prices, and per-channel prices must
  not be compared as if they were equivalent.
- An annual-commitment monthly rate must not be compared with a true monthly
  rate unless both commitment terms are observed and aligned.
- No fixture plan may appear in a live report.

## Validation

- Offline tests cover Buffer-, Linear-, ClickUp-, and Asana-like pricing markup,
  unstructured-prose rejection, tier matching, and billing-basis safety.
- Run typecheck, production build, all tests, lint, and diff checks.
- Run a strict Fable 5 review and resolve every blocker.
- Deploy the exact reviewed commit privately and validate at least Linear and
  Buffer against their autonomously discovered competitors.

## Acceptance gate

- Linear produces at least two visible plan-tier rows against a verified SaaS
  competitor, including one aligned public price comparison when available.
- Buffer produces named plan rows instead of a `Social media` tautology.
- No cross-period or cross-unit exact price delta is emitted.
- Tier-based matches are labeled as `Same tier` instead of presenting the
  eligibility floor as a synthetic similarity percentage.
- Every plan name and price links to a first-party pricing page.

## Review record

- Fable 5 strict review: `SAAS_PLAN_COMPARISON_REVIEW: PASS`.
- The reviewer identified two non-blocking truthfulness improvements: avoid
  comparing annual-commitment monthly rates with true monthly rates, and do not
  display the tier-match eligibility floor as a similarity percentage.
- Both improvements were implemented and independently probed by Fable 5.
- Final verdict: `SAAS_PLAN_COMPARISON_REREVIEW: PASS`.

## Live validation follow-up

- Private Sites version 28 produced four named Linear plan rows against Asana
  and three named Buffer rows against Loomly and Sprout Social.
- The first live Linear run correctly withheld an exact delta because duplicated
  accessible price markup pushed the explicit `Billed yearly` text beyond the
  short price context. The bounded plan section is now retained separately for
  explicit billing-term extraction; price selection remains limited to the
  short nearest-price context.
- Fable 5 reviewed the live-found correction for cross-card leakage, false
  commitment inference, price misbinding, and test adequacy. Final verdict:
  `LIVE_BILLING_CONTEXT_REVIEW: PASS`.
- Version 29 showed the real Linear card's accessible duplication also exceeded
  the 4,000-character billing-term window. Billing terms are therefore scanned
  across the complete same-card section, still stopping at the next heading;
  price selection remains capped to the nearest 1,200 readable characters.
- Fable 5 verified this semantic-boundary correction, including final-card
  behavior and performance. Verdict: `FULL_CARD_BILLING_REVIEW: PASS`.
