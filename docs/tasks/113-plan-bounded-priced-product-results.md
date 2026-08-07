# Task 113 — Plan-bounded, priced product results

## Outcome

Make the server-owned subscription entitlement determine how many first-party
products a report may assess, and publish a comparison only when the rival
product carries a valid observed public price.

## Product limits

- Starter: 20 products per report.
- Solo: 50 products per report.
- Growth: 500 products per report.
- Agency: 1,000 products per report.
- The global hard ceiling remains 1,000.

Until account/workspace billing lands, entitlements come from server-owned
configuration. `MARKET_SIGNAL_PLAN_REGISTRY_JSON` maps canonical domains to a
plan and `MARKET_SIGNAL_DEFAULT_PLAN` defaults to `starter`. Request bodies,
headers, and query strings cannot select a plan. The resolved entitlement is
persisted with the report run and remains fixed across worker retries.

## Publication rule

- Matching may assess any candidate needed within the entitled budget.
- An accepted pair is published and persisted only when the rival product has
  a finite positive numeric amount and a supported ISO currency observed from
  its public product evidence.
- Missing, zero, negative, non-numeric, or unsupported-currency rival prices
  suppress the pair rather than producing a misleading comparison row.
- Coverage records the number and reason for suppressed accepted pairs.

## Acceptance checks

- Unit tests cover all four plans, clamping, invalid configuration, domain
  registry resolution, and ignored client plan fields.
- A report stores its resolved plan and limit in SQLite and dispatches the same
  values on initial work and recovery.
- Matching tests cover every invalid rival-price shape and a valid price.
- The full build, lint, and test suite pass.
- A real `myjam.co.uk` Agency run assesses up to 1,000 public products and the
  live report contains no competitor product without an observed public price.
- Strict Fable 5 review passes before merge; a Codex subagent may review while
  Fable is limited but does not replace the merge gate.

## Validation evidence

- Typecheck and production builds passed.
- Full automated suite: 544/544 tests passed.
- ESLint: zero errors; two pre-existing `img` performance warnings remain.
- Diff whitespace check passed.
- Real production validation remains pending the dependency merge, strict
  Fable gate, Trigger/VPS deployment, and a fresh MyJam report.
