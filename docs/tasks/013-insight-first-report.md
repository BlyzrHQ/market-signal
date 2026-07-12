# Task 013 — Insight-first report

## Problem

The report rendered one large card for every raw observed claim: title, description, heading list, price strings, language, and timestamps. These records proved that collection happened but did not help a customer understand the market.

## Decision

The customer-facing JSON renderer shows only decision-bearing blocks:

- market summary and inferred category
- verified competitors with discovery and crawl proof
- product-by-product comparisons and unmatched competitor products
- concise data-coverage notes when evidence is missing or a candidate is rejected

Raw company profiles, crawl coverage counters, possible-link candidates, product-catalog dumps, and evidence-ledger rows remain available to server-side analysis but are not rendered in the main report.

## Acceptance criteria

- No standalone Observed/Inferred evidence cards appear in the report.
- Source links remain attached to competitor conclusions, product matches, and AI signals.
- Missing or rejected evidence remains visible as a concise coverage note.
- Automated checks prove the raw evidence branch cannot render.
