# Durable direct-comparison progress

## Problem

The direct product-search matcher processes first-party products sequentially
inside one bounded HTTP request. It durably stores paid search leads, but it does
not store the resulting priced comparisons. A timeout therefore causes a retry
to enrich every earlier lead again, and repeated timeouts can leave a report
with no customer-visible comparison result even though valid priced rows were
already found.

## Scope

- Persist one validated comparison outcome after each processed primary
  product, upgrading the existing paid-search checkpoint with compare-and-swap
  semantics.
- Reconstruct every response from durable per-primary outcomes and process only
  a bounded amount of new work per HTTP call.
- Serialize direct-matcher requests for one report attempt with an expiring
  database lease so overlapping retries cannot duplicate paid searches.
- Treat a provider-completed or provider-bounded search as one processed
  primary. Preserve its gap instead of paying for the same search forever.
- Publish only rival results with finite positive observed prices and supported
  currencies.
- Preserve the strongest verified partial result on the final Trigger attempt.

## Non-goals

- No paid production report or evaluation is launched by this task.
- No catalog-size or plan-entitlement change.
- No return to Sites or another generic crawl proxy.
- No semantic AI judge is added to direct search.

## Architecture review

Claude's bounded architecture review returned a conditional GO. It required
per-primary atomic progress, stale-writer protection, a single-writer lease,
input/schema hash fail-closed behavior, write-time positive-price validation,
and publication from durable state. It recommended shipping blocked-storefront
recovery as a separate stacked change.

## Acceptance criteria

- A second call does not search or enrich primaries whose priced outcomes were
  durably committed by the first call.
- A simulated failure after one committed primary retains that comparison.
- A stale compare-and-swap cannot overwrite a newer result.
- An overlapping direct-matcher request is rejected before paid search.
- A bounded call returns `processing-incomplete` with its committed rows; catalog
  exhaustion returns a terminal shortfall instead of an infinite retry state.
- Focused route, matcher, store, orchestration, typecheck, build, and full tests
  pass before merge.

## Real-data boundary

Read-only public HTTP probes may confirm that the affected storefronts remain
available. Customer reports and paid comparison searches require separate user
approval and are not part of this validation.

## Validation

- Focused matcher, route, and persistence tests: 56 passed.
- Full repository test command: 1,170 passed, 0 failed. This includes both
  TypeScript projects and the production Next.js build.
- Lint: 0 errors. One pre-existing `@next/next/no-img-element` warning remains
  in `app/components/product-design-lab.tsx`.
- No paid production report or evaluation was launched.
