# Task 006 — Grounded AI market brief demo

## Goal

Turn the live public-domain scan into a first AI result that feels like an
investigation: every generated insight must resolve to observed source claims.

## Product decision

The end product does not use Fable 5. A standard model adapter is supported via
`OPENAI_API_KEY` and `MARKET_SIGNAL_MODEL` (default `gpt-4o-mini`). The evidence
collection and claim validation remain deterministic. If no runtime key exists,
the demo uses a clearly labeled grounded fallback so the experience remains
usable without pretending that model output was generated.

## Acceptance criteria

- A domain scan can generate a grounded market brief from live public results.
- The brief contains a headline, summary, three market signals, implications,
  next checks, and source-backed claim IDs.
- Model-generated claims are filtered so unsupported claim IDs cannot render.
- The UI distinguishes AI-generated output from the no-key demo fallback.
- No exact ad spend, private data, or unsupported competitor facts are shown.
- Build, lint, rendered HTML tests, and at least one real public-domain check
  pass before the task is published.

## Known limitation

The demo currently uses homepage evidence. Pricing-page crawling, historical
diffs, and official ad-library adapters are the next evidence-collection tasks.

## Review record

Explicit Sonnet 5 review completed after implementation. It found no blockers
after the report endpoint was changed to re-fetch requested domains server-side
and require claim-backed headline and summary IDs. Remaining limitation: model
text is checked for valid claim IDs, not full natural-language entailment.
