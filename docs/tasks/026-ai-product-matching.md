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
- Final Fable gate remains pending until a deployed MyJam run records real matching, latency, call counts, source URLs, and close-substitute price safety below.

## Live validation record

Pending private deployment of this exact commit. Do not mark this task complete or merge until populated with observed evidence.
