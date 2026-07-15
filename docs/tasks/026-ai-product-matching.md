# Task 026 — AI product matching

## Outcome

Replace the lexical-only product-pair gate with a bounded hybrid pipeline that can recover semantic, synonym, and cross-language substitutes without turning model judgment into observed fact.

## Scope

- Retrieve candidates using lexical signals plus batched text embeddings.
- Judge bounded candidate sets with the OpenAI Responses API and a strict JSON schema.
- Classify each candidate as `same_product`, `close_substitute`, `related`, or `no_match`.
- Keep deterministic category/accessory/type/variant vetoes authoritative.
- Allow exact price comparisons only for `same_product` pairs with compatible observed variants.
- Label model output as `Inferred` / `AI assessed`, including model, prompt version, reasons, contradictions, and both source URLs.
- Fall back to the existing lexical matcher when AI is unavailable or the report budget is exhausted.
- Cap model work with a report-wide deadline and expose coverage gaps instead of silently dropping it.

## Non-goals

- No all-pairs model judging.
- No persistent vector database.
- No client-side API keys.
- No fine-tuning before a labeled evaluation set exists.
- No exact ad-spend or product-price claim authored by a model.

## Acceptance criteria

1. Semantic retrieval can surface a synonym or Arabic/English pair that the two-token matcher misses.
2. Strict structured verdicts are sanitized; unknown IDs and malformed output cannot create matches.
3. Service/product and accessory contradictions remain rejected even if AI says `same_product`.
4. `close_substitute` never enables an exact price delta.
5. API-key absence, timeout, malformed output, or budget exhaustion returns a valid lexical report and a visible gap.
6. Calls are bounded by configured primary-product, candidate, report deadline, request timeout, and concurrency limits.
7. UI says `AI assessed` and shows the verdict rationale; observed source facts remain separate.
8. Unit tests, typecheck, build, lint, Go tests, contract validation, a real MyJam run, and a strict Fable 5 review pass before merge.

## Architecture decision

Fable 5 returned a conditional PASS for the hybrid approach. It rejected lexical-only retrieval feeding an AI judge because cross-language pairs would never reach the judge. It recommended per-report batched embeddings, bounded structured judging, deterministic vetoes, explicit inference labels, and lexical degradation. Pixel-level image review remains a separate follow-up so this task does not imply that an image URL was visually inspected.

## Model defaults

- Embeddings: `text-embedding-3-small`, configurable with `MARKET_SIGNAL_MATCH_EMBEDDING_MODEL`.
- Structured judge: `gpt-5.4-mini`, configurable with `MARKET_SIGNAL_MATCH_MODEL`.
- The API key remains server-side in `OPENAI_API_KEY`.

## Review record

- Fable 5 architecture review: conditional PASS for embeddings retrieval plus a structured judge, deterministic vetoes, bounded calls, and visible lexical fallback.
- Fable 5 code review round 1: FAIL. It identified an over-broad Product/Service veto, unbounded all-pairs lexical rescoring, and missing real-domain evidence.
- Round-1 fixes: the veto now permits an observed subscription-box identity while retaining service-only contradictions such as catering; retrieval uses bounded token and embedding-locality pools and reports `retrievalPairsScored`.
- Live MyJam attempt 1 on Sites version 46 / commit `083e900`: discovery verified five competitors, but all 12 five-primary judge batches reached the 18-second request limit. The report correctly degraded to lexical matching, exposing one Indomie pair and no unsafe price delta. This is a failed usefulness gate, not successful AI validation.
- Attempt-1 response: reduce the default AI surface to 30 primary products, eight finalists per primary, two primaries per judge call, and 6,000 output tokens; allow a 45-second report-wide budget with 30-second request bounds and four-way concurrency; aggregate repeated deadline gaps.
- Live MyJam attempt 2 on Sites version 47 / commit `a5eb4a5`: the combined crawl-plus-AI request crossed the host request limit and returned an HTML 500 after 56.6 seconds. The combined architecture failed the production gate.
- Attempt-2 response: move AI matching to `/api/match` after the crawl response. The UI runs market brief, ads, and AI product matching as independent progressive phases, so model latency cannot discard the verified crawl report.
- Live MyJam attempt 3 on Sites version 48 / commit `b452584`: the independent crawl returned HTTP 200 in 38.0 seconds, and `/api/match` returned HTTP 200 in 47.1 seconds. This passed the real-data usefulness gate below.
- Fable 5 code review round 2: PASS. It independently verified the narrowed service veto, bounded retrieval path, progressive endpoint isolation, route sanitization, matching tests, and attempt-3 usefulness/price-safety evidence. It retained multi-domain precision benchmarking and a formal endpoint contract as non-blocking follow-up work.

## Live validation record

Observed at `2026-07-15T11:12:58.531Z` against the deployed MyJam report:

- Crawled 400 first-party products and 601 competitor products across `egrocers.uk`, `asianfresh.co.uk`, `asiangrocerystore.uk`, and `foodsouq.co.uk`.
- `gpt-5.4-mini` with `text-embedding-3-small` assessed 28 primary products and 191 candidate pairs using 15 judge calls and two embedding calls. The bounded retrieval layer scored 1,578 possible pairs.
- Returned 20 source-linked assigned comparisons. Eight were useful semantic matches that the deterministic lexical eligibility gate would not have admitted, including 500g vine tomatoes, whole lamb shoulder, chicken drumsticks, and baby chicken pack variants.
- All rows retained first-party source URLs for both products and an AI verdict, confidence, and rationale. Examples include MyJam `Fine Beans 500g` versus Asian Fresh `Fine Beans 300g` (`close_substitute`, 0.96) and MyJam `Red Sweet Potato 500g` versus Asian Fresh `sweet potato red 500g` (`same_product`, 0.99).
- No `close_substitute` produced an exact price delta. Two of 30 selected primary products reached the report deadline; that coverage limitation remained visible and their lexical fallback was retained.
- This validates useful recovery and safety on one real public domain; it does not establish global precision. A labeled multi-domain benchmark remains follow-up work.
