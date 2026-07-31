# Task 087 — Full report fact persistence

## Goal

Persist every observed company, product, accepted product match, and attributable
ad creative concept exposed by the current scanner before the compact presentation document is saved. This supplies the
complete, versioned evidence snapshot required by Task 086 without using the
40-product renderer snapshot as if it were the full catalog.

## Contract

- Trigger sends bounded fact chunks through the existing authenticated internal
  report callback boundary; the Trigger worker receives no database authority.
- A chunk contains one fact kind, at most 50 sanitized records, its zero-based
  index, total chunks for that kind, manifest ID, and SHA-256 content hash.
- Each chunk and its records commit atomically. Exact replay is idempotent;
  reusing a chunk identity with different content returns conflict.
- Companies and products come from the full crawl results. Matches come from
  accepted comparison rows after enrichment and action planning. Because the ads
  surface is currently marked coming soon, persistence records only the bounded,
  attributable creative concepts already exposed by the scanner; it does not
  claim to retain uncapped provider placement rows. Unavailable states remain
  report gaps, not zero activity.
- Finalization verifies chunk continuity, chunk counts, item counts, relational
  counts, and a manifest hash derived from ordered chunk hashes.
- The compact report document remains unchanged and independently available if
  fact persistence fails. A missing or incomplete manifest is a future
  `insufficient_facts` evaluator state, never a hidden complete snapshot.

## Schema

Add `report_fact_chunks` keyed by `(run_id, manifest_id, kind, chunk_index)` with
chunk count, item count, content hash, and creation time.

Add `report_fact_manifests` keyed by `run_id` with manifest identity/hash,
company/product/match/ad totals, status, and completion time. A run can have one
immutable completed fact manifest because terminal report documents are also
immutable.

## Safety and bounds

- Accept only records belonging to the stored run and primary/competitor domains
  supplied by that run's crawl.
- Store HTTP(S) source URLs only; reject credentials and unsafe URL forms.
- Bound text, arrays, metadata JSON, chunk records, and callback body size.
- Never accept arbitrary SQL fields, model instructions, secrets, cookies, or
  raw HTML.
- Hash canonical JSON after sanitization so semantically identical replay is
  stable.
- Do not delete or overwrite completed facts through this API.

## Acceptance criteria

1. A catalog larger than the renderer cap persists every relational product.
2. Exact chunk replay succeeds without duplicate facts.
3. Conflicting replay fails without changing prior facts.
4. Manifest finalization rejects missing, duplicated, out-of-order, or
   count-mismatched chunks.
5. Product prices and images remain attributable to their product source URLs.
6. Accepted matches retain verdict, confidence, model/prompt version, and source
   evidence without inventing a product record.
7. Parked/unavailable and fact-persistence failures do not prevent the truthful
   terminal report document from being saved.
8. SQLite and D1-shaped database tests, orchestration tests, typecheck, build,
   lint, and full tests pass.
9. A real ecommerce report produces a complete manifest whose totals match the
   relational tables.
10. Strict Fable 5 review returns PASS before merge and deployment.

## Implementation notes

- One shared canonicalizer normalizes domains, URLs, dates, optional fields, and
  bounded JSON before either side hashes a record. Trigger sends the exact
  canonical records that storage verifies.
- Manifest identity is derived from the complete canonical fact set rather than
  an attempt timestamp. Exact retries therefore retain one identity. A new
  content manifest may atomically supersede an incomplete prior manifest only
  when its first company chunk arrives; completed manifests remain immutable.
- A completed manifest is returned with the stored run. If document transport
  failed after manifest finalization, the next Trigger attempt reuses the saved
  counts and does not rewrite or falsely limit the fact set.
- Facts are deduplicated by relational identity. Product facts include final
  comparison/enrichment products, and a product-bearing crawl result receives a
  company row even when its homepage was unavailable.
- Chunks obey both the 50-record ceiling and a 250 KB producer byte budget,
  below the authenticated callback's 1.5 MB raw-body limit.

## Review history

The first strict Fable 5 review returned `FABLE_TASK_087_BLOCK`. It identified
attempt-dependent manifest IDs, hash drift between raw and sanitized values,
duplicate-count deadlocks, missing enrichment/product-bearing-domain handling,
insufficient negative tests, and item-only chunk sizing. The implementation was
reworked rather than waived; a second strict review is required after the full
validation gate.

When Fable reached its session limit, two authorized Codex subagents performed
interim strict audits. Both blocked the candidate on concurrency and boundary
hardening. The follow-up adds attempt ownership, a `finalizing` database lock,
conditional chunk writes, concurrent replay coverage, server-side count/byte
limits, first-party and official-platform source checks, nested field
allowlists, stale-worker rejection, and best-effort quality telemetry that can
never prevent the terminal document callback. These interim reviews do not
replace the required Fable PASS after reset.

The fallback re-review found additional transactional issues: worker events and
documents also needed attempt ownership, finalization needed owner-token cleanup,
deduplication needed deterministic richer-record precedence, recovery needed an
original-attempt CAS, and URL/ad evidence validation needed one canonical public
URL and official-record policy. A final audit also separated the database report
attempt from Trigger's automatic task retry, added stale-heartbeat CAS, tightened
Meta path boundaries, and measured complete callback envelopes. Those findings
were implemented and covered by two-connection race and boundary tests before
returning to the Fable gate.

## Validation

- `npm test`: PASS (typecheck, production build, 392/392 tests).
- `npm run lint`: PASS with zero errors and two pre-existing `no-img-element`
  warnings outside this task's changed UI surface.
- Real SQLite integration stores 63 deduplicated products, one accepted match,
  and one attributable ad while the presentation snapshot remains capped at 40.
- Negative integration coverage verifies conflicting replay, partial-manifest
  replacement, missing chunks, wrong hashes/counts, immutable completion,
  terminal writes, domain/reference isolation, cross-report IDs, completed
  retry reuse, URL canonicalization, duplicate collapse, byte-bounded chunks,
  stale-attempt rejection across every worker callback, owner-token finalization,
  recovery races, concurrent exact replay, official ad-record URLs, and rejection
  of intranet/private/link-local URL variants.
