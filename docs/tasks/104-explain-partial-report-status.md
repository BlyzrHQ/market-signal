# Task 104 — Explain partial report coverage

## Problem

The saved-report dashboard displays `LIMITED` as a bare status inside a small
domain card and the route header. A customer cannot tell whether the report
failed, which part is incomplete, or whether the visible findings are usable.
The domain card also gives the site identity and status equal visual weight,
without a useful hierarchy.

## Decision

- Present terminal `limited` reports as **Partial coverage**.
- Keep this state distinct from failure: the report remains usable and all
  visible findings remain tied to saved public evidence.
- Derive the explanation from persisted report events, prioritising product
  matching, enrichment, competitor discovery, market brief, then other phases.
- Redesign the sidebar card around report scope, domain, readiness, limitation,
  and freshness.
- Repeat a concise coverage notice in the report canvas and keep a compact
  status chip visible on small screens.

## Acceptance

- A limited report never shows an unexplained `LIMITED` label.
- The Babanuj report explains that matching coverage is partial without
  discarding its accepted matches.
- Complete reports show `Ready`, not a warning treatment.
- English and Arabic labels and explanations are available.
- The mobile header keeps the coverage status visible.
- Existing report navigation and product data are unchanged.
- Build, lint, report-route tests, strict review, and live browser QA pass.

