# Task 012 — Real competitor discovery

## Outcome

A customer submits one domain. Market Signal infers the business category and region, searches the current public web for likely competitors, then independently crawls and scores those candidates before presenting them.

## Product rules

- Comparison domains are not requested from the customer.
- AI search proposes candidates; it does not confirm them.
- A confirmed competitor must have a successfully crawled public site plus a 45-point minimum from independent search, lexical, regional, and product-overlap signals.
- Every competitor card includes the discovery query, source, verification score, and explicit confidence.
- Missing search credentials or provider failures are shown as coverage gaps, never replaced by fixtures.

## Acceptance criteria

- One-domain request triggers discovery and competitor crawling.
- Unreachable candidates and the primary domain are excluded.
- The report leads with competitors and product comparisons, while crawl diagnostics are secondary evidence.
- Tests cover response parsing, candidate sanitization, and unavailable-provider behavior.
- `myjam.co.uk` is exercised against the deployed endpoint with real public data.
