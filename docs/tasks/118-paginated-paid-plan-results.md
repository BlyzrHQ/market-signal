# Task 118 - Paginated paid-plan product results

## Problem

Growth and Agency reports can assess hundreds of products and persist hundreds
of authoritative matches in SQLite, while the public snapshot is intentionally
compacted below 700 KB. The product dashboard currently counts only compacted
rows and labels that number as the products assessed. In the MyJam Agency run
`54d29c02330e4005a32c17912c4dd1b0`, SQLite retained 276 authoritative matches
from 1,000 assessed products, but the snapshot retained 50 product rows and the
dashboard displayed 75 accepted matches, 50 price deltas, and "50 products
assessed." This misrepresents the paid entitlement and hides saved results.

## Goal

Make Growth and Agency reports deliver their complete authoritative SQLite
match set without increasing the terminal snapshot budget.

## Proposed contract

- Keep the compact snapshot as the fast initial report payload.
- Add a public-report-scoped, read-only, paginated match endpoint backed by the
  immutable completed relational fact manifest.
- Return only source-linked report facts belonging to the requested public
  report. Reject incomplete/non-authoritative manifests.
- Show authoritative assessed and accepted totals separately from the number
  currently displayed.
- Load additional match pages in the product dashboard with deterministic
  ordering and no duplicate pairs.
- Export the complete authoritative match set, not only the compact snapshot.
- Keep source URLs, observed prices, images, verdicts, evidence, and claim
  boundaries intact. Do not reconstruct unsupported recommendations.
- Preserve a transparent compact-snapshot fallback when relational facts are
  unavailable.

## Acceptance criteria

1. The Agency MyJam report identifies 1,000 assessed products and 276 accepted
   matches as authoritative totals while stating how many are currently shown.
2. The Growth report uses the same contract and does not label compacted rows
   as the total products assessed.
3. Pagination cannot cross report boundaries, expose incomplete fact sets, or
   return duplicate matches.
4. The product table can progressively load every authoritative match.
5. CSV export includes every authoritative match after all pages are fetched.
6. Starter and Solo remain correct and retain a compact fallback.
7. Focused tests, full tests, build, lint, strict Fable 5 review, and live
   Growth/Agency verification pass before merge.

## Review state

Verified Claude Fable 5 (`claude-fable-5`) returned an architecture PASS. The
review requires deterministic keyset pagination on `(rival_domain, id)`, a
complete-manifest authority gate, server-side joins into the existing product
battle shape, immutable page caching, relational rows replacing rather than
merging with snapshot rows, and a permanent compact-snapshot fallback. The
Products badge must use the authoritative match total. Actual assessed products
come from `matching.primaryProductsAssessed`; the plan limit remains separate.
CSV export must fetch all remaining authoritative pages before creating a file.

Fable confirmed that `report_matches.evidence_json` plus the two indexed
`report_products` joins retain names, images, prices, quantities, verdicts,
evidence, and grounded actions. No recommendation needs to be invented.
