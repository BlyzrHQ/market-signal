# Durable report phase resume incident

## Incident

Production report task retries restart the primary crawl even after a successful catalog and competitor crawl. A later transient HTTP 403 can therefore replace useful collected evidence with a terminal crawl failure. Matching retries also fail the whole report on their last bounded attempt instead of publishing the best durable, visibly limited result.

## Required outcome

- Save a validated checkpoint after each successful discovery wave.
- Reuse a completed checkpoint on later task attempts; when discovery is incomplete, advance to the next wave while retaining the prior successful checkpoint as fallback.
- Never let a later crawl access failure erase a prior successful crawl for the same report attempt and entitlement.
- On the final bounded matching attempt, publish the best durable result as limited when one exists; do not convert it into a total report failure.
- Preserve explicit coverage gaps and processing-incomplete explanations.

## Validation

- Regression tests prove retry reuse, crawl-failure protection, and final limited publication.
- Run the relevant unit tests, full test suite, lint, and build.
- Obtain the required strict review for this production data-handling change.
- Deploy Trigger before the exact approved VPS commit.
- Verify production health and one MyJam plus one Babanuj canary without claiming unsupported data quality.

## Data boundary

The checkpoint contains only public crawl results already collected for this report. No fixture data or invented facts may enter a live report.
