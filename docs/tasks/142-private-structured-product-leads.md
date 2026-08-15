# Task 142 — Private structured product leads

## Problem

A fresh Arabic `noororganicfood.com` production report found 242 primary
products but no verified competitor. Product search returned one structured
candidate, while the product lane deliberately discarded structured output and
had no attributable low-level search-source URL to investigate. The report
therefore fell back to company roots that could not prove product overlap.

## Decision

Use a structured candidate's exact first-party product-detail URL only as a
bounded private investigation lead. This is routing metadata, not evidence and
not a customer-visible claim. Do not widen low-level query attribution.

The existing publication gates remain mandatory: the requested exact page must
be crawled, expose one first-party structured `Product`, contain a finite
positive supported-currency price, fit the target region, and pass the pinned
semantic judge as the same product or a close substitute with confidence at
least 0.8 and no contradictions.

## Boundaries

- Require one primary anchor and consistent candidate, website, evidence, and
  exact product URL domains.
- Reject roots, listings, marketplaces, the primary brand, same-brand domains,
  publisher routes, unsafe URLs, and cross-domain product URLs.
- Admit at most one structured private lead per product lane and share the
  existing global two-candidate private-investigation cap.
- Keep observed and URL-attributed candidates ahead of private leads.
- Strip private lead fields and untrusted model metadata from every failed raw
  response and document surface.
- Rewrite successful evidence only from the independently verified exact pair.
- Make discovery gaps distinguish sanitation from independent verification.

## Validation

- Focused discovery and exact-pair route tests.
- Full test, typecheck, build, and lint suites.
- Strict Fable 5 review of the exact PR head.
- Trigger then VPS deployment of the approved merge commit.
- Fresh `noororganicfood.com` production acceptance with at least one verified
  rival and one comparison carrying a finite positive supported-currency rival
  price before the 20-site multilingual matrix starts.
