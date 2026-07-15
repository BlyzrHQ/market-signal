# Task 027 — Stable progressive product matching

## Outcome

Prevent a thin or unfinished product-matching phase from appearing to be the complete market answer. A MyJam run that can recover materially more comparisons must not silently settle at two cards.

## Root cause hypothesis

- The crawl document renders before `/api/match` completes, but the product section does not say that its lexical cards are preliminary.
- A single thin AI response can replace the baseline comparison without a bounded retry or a quality comparison against the baseline.
- The client only replaces an existing comparison block; it does not append the AI block if the crawl had no initial comparison block.
- Discovery and model output can vary between runs, but the current page exposes no limited-coverage state when the final result is suspiciously thin.

## Scope

- Add an explicit `matching`, `retrying`, `complete`, and `limited` product-matching lifecycle to the report UI.
- Retry `/api/match` once only for a coverage defect: transport failure, explicit matching gaps, an unavailable semantic phase, or fewer assessed primaries than the selected comparison surface.
- Compose at most two AI attempts per primary product. An AI verdict, including `no_match`, remains authoritative for every primary it successfully assessed; lexical rows survive only where neither AI attempt completed assessment.
- Prefer an AI attempt by assessed coverage and fewer gaps, never by its number of accepted matches.
- Replace or append the product-comparison block atomically.
- Preserve server-side keys, source boundaries, deterministic vetoes, and price-safety rules.

## Cost boundary

- Normal reports make one matching request.
- Only a result that fails the deterministic quality gate may make one additional request.
- The model remains `gpt-5.4-mini` with `text-embedding-3-small` by default.

## Acceptance criteria

1. The first crawl result labels product cards as preliminary until semantic matching finishes.
2. A retry fires only on a coverage defect and is hard-capped at one. A defect-free thin result never retries.
3. Final rows compose per primary product: the chosen AI attempt's verdict, including rejection, is final for every successfully assessed primary; lexical rows appear only for primaries neither attempt assessed.
4. `limited` appears only when coverage defects remain after retry. A defect-free result with few pairs is labeled complete and states the found count plainly.
5. An AI comparison is appended when the crawl document had no product-comparison block.
6. Unit tests cover lifecycle thresholds, retry bounds, best-result selection, and append/replace behavior.
7. The full TypeScript/build/lint/Go test gate passes.
8. Two consecutive deployed MyJam checks record their competitor sets and each expose at least five defensible visible comparisons when the crawl observes at least 100 primary and 100 competitor products; no coverage-defective run may present itself as complete.
9. A clean low-overlap control proves that a defect-free result with fewer than five pairs does not retry and is not labeled limited.
10. In-app browser QA observes the preliminary state and the terminal AI state on the deployed site and confirms the final visible count.
11. Stale matching responses are discarded with monotonic run/attempt tokens; the UI never renders a mixture of attempts, and preliminary always reaches a terminal state within the bounded request lifecycle.
12. Strict Fable 5 review passes before merge; Fable performs the merge after deployment and browser verification.

## Architecture review

- Fable 5 round 1: FAIL. It rejected whole-result “most matches wins” selection because that could restore lexical false positives rejected by AI, and rejected count-based retries because a genuinely sparse market would incur permanent double cost and a false limited label.
- Response: retries are coverage-defect-only; AI rejections remain authoritative per primary; attempts are ordered by coverage/fewer gaps; a clean thin result is complete.
- Fable 5 round 2: PASS. It accepted per-primary composition, coverage-only retry, authoritative AI rejections, and the bounded one-retry cost model.
- Fable 5 code review round 1: PASS with no blockers. Follow-up hardening skips an impossible no-primary-product request, avoids retrying an explicitly unconfigured matcher, keeps the terminal limited banner visible without a comparison block, and uses coverage-neutral limitation wording.

## Evidence record

Pending implementation and deployed validation. Do not merge while browser QA or repeat-run evidence is missing.
