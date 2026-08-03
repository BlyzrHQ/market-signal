# Task 103 — Bounded terminal report snapshot

## Problem

Task 102 recovered the missing Babanuj product evidence. Fresh report `042070fde8b642a0aaa9a6c913ff3b2c` finalized 7 company facts, 2,665 product facts, and 23 product matches. The persisted primary catalog contains 81 Babanuj products, all 81 with a public image and price, including the four known catalog replacements with their current identities and audit attributes.

The terminal presentation then failed. The completed fact manifest remained durable, but the report ended as failed after the presentation callback returned HTTP 400 and the task retry later ended on a crawl HTTP 400. The current snapshot compactor caps products per block but has no global UTF-8 byte budget. Multiple rich catalogs, company pages, evidence, gaps, and comparison rows can therefore exceed the 750,000-byte stored-document limit or the 1,500,000-byte callback envelope.

## Decision

Use one runtime-neutral, deterministic, byte-budgeted presentation compactor in Trigger and the application server.

- Target at most 700,000 UTF-8 bytes for the presentation document.
- Preserve the 750,000-byte stored snapshot hard limit and 1,500,000-byte callback envelope.
- Compact before Trigger serializes the terminal callback and again at the route/store boundaries.
- Keep summary, market profile, benchmark, verified competitors, domain coverage, product comparison, public source links, and explicit limitation metadata.
- Project presentation products to useful public fields and remove duplicated long descriptions, normalization text, claim IDs, and attributes from the snapshot only. Relational product facts remain authoritative and unchanged.
- Bound catalog, unmatched, gap, evidence, company-page, and, only if required, comparison-row samples in deterministic stages.
- Preserve truthful total, persisted, and truncated counts across repeated compaction.
- Fail closed with a typed compaction error if the essential projection cannot fit.

## Acceptance

- A 7-company, 2,665-product, 23-match fixture compacts below 700,000 UTF-8 bytes.
- The complete callback envelope remains below 1,500,000 bytes and the HTTP transport never receives the raw oversized document.
- Compaction is deeply and byte-for-byte idempotent.
- Product, gap, evidence, page, and comparison totals remain truthful after a second compaction.
- Useful competitor, coverage, comparison, image, price, and source-link fields remain.
- Arabic and other multibyte values are measured by encoded bytes.
- A retry with a completed fact manifest performs no fact-chunk writes.
- Lost-response replay accepts an identical compacted document and rejects a conflicting one.
- A new real Babanuj report reaches `complete` or truthfully `limited`, persists its document, and renders the 81 recovered primary images and prices.

## Review record

- Claude Fable 5 was invoked with the verified model identifier. The process remained silent for more than seven minutes and was stopped without returning a verdict, so it was not counted as a review.
- The repository-approved strict GPT-5.6 fallback first returned **PASS-A** only for a shared deterministic byte-budgeted projection; additional fixed per-block slices were rejected as insufficient.
- The strict implementation review found that the public read path could not hydrate authoritative products, authority was not manifest-bound, nested content needed more bounds, ordering needed to be locale-independent, accepted comparisons needed priority, and raw-only prices needed preservation. Each finding was fixed and re-reviewed.
- The final strict fallback review returned **PASS** with no material findings after independently verifying manifest authority, explicit stale-count clearing, truthful nested truncation, UTF-8 byte limits, replay behavior, and bounded relational hydration for all 81 Babanuj products.
