# Task 063 - Unavailable-domain limited report

## Problem

A fresh production report for `baklali.app` failed with `Public crawl request failed with HTTP 400.` The submitted domain and its `www` variant currently return DNS `NXDOMAIN`, so no public company website exists at that address to crawl. The crawl route already performs two bounded homepage attempts and returns a structured document with the attempted URL, observation time, and coverage gaps, but the Trigger HTTP adapter discards that non-2xx body. The user sees an opaque failed run instead of a durable explanation.

## Outcome

Persist a truthful limited report when the primary domain remains network-unavailable after the crawler's bounded attempts. Explain that competitor, product, ad, and matching work did not run and that the result is not evidence of zero competitors, zero products, or zero ads.

## Safety boundary

- This path applies only when both bounded primary crawl attempts receive a non-timeout network failure with no HTTP response (`status: 0`) for the same submitted public HTTPS URL.
- Timeouts remain retryable failures so a slow but live storefront is not mislabeled as unavailable.
- HTTP responses such as 403, 404, 429, and 5xx remain failures with their existing retry behavior; they are not reclassified as an unavailable domain.
- The report says only that no public HTTP response was obtainable at the observation time. It does not claim DNS failure unless independently observable evidence supports that exact diagnosis.
- The attempted URL is labeled as a crawl target, not as successfully observed page content.
- Malformed or mismatched non-2xx bodies fail closed at the Trigger boundary.

## Design

- Preserve the homepage fetch failure kind on the crawl result and classify the primary as `unavailable` only after the second bounded attempt returns a network-level failure.
- Return a typed `409 unavailable-domain` response containing the exact primary domain, a `domain-status` block, a matching coverage gap, attempt count, observation time, and attempted HTTPS URL.
- Strictly validate that typed response in the Trigger HTTP adapter before accepting it.
- Generalize the existing terminal-limited orchestration path so parked and unavailable domains use truthful status-specific language while skipping brief, ads, matching, and enrichment.
- Render the saved unavailable report with only Overview, Evidence, and Methodology tabs and an explicit retry/correct-domain action.

## Acceptance criteria

- Two non-timeout network-level homepage failures produce one structured `409 unavailable-domain` result; a timeout, a single failure followed by a live homepage, or mismatched attempted origins does not.
- HTTP status failures and malformed unavailable responses are not accepted as terminal limited.
- A valid unavailable result saves exactly one `limited` report with `completedPhases: [persistence]` and `limitedPhases: [crawl, brief, ads, matching]`.
- No brief, ad, match, or enrichment work runs for the unavailable primary domain.
- The dashboard does not show empty market tabs or imply that no competitors, products, or ads exist.
- Tests, typecheck, production build, and lint pass.
- Fable 5 strictly reviews the implementation. After PASS, deploy the exact commit to Sites and Trigger and verify a fresh `baklali.app` run in the production browser.

## Production evidence before implementation

- Report: `0ffe83a91420498ea4b182177bb9909b`
- Result: failed with `Public crawl request failed with HTTP 400.`
- Browser navigation to `https://baklali.app` returned `net::ERR_NAME_NOT_RESOLVED`.
- Independent DNS checks for `baklali.app` and `www.baklali.app` returned `DNS_ERROR_RCODE_NAME_ERROR`.

## Local validation

- `npm test`: `304/304` tests passed, including typecheck and a production build.
- `npm run lint`: zero errors and one pre-existing `<img>` optimization warning in `app/components/product-design-lab.tsx`.
- Regression coverage proves that timeouts, one-off failures, different origins, malformed 409 bodies, and mismatched evidence are not accepted as an unavailable-domain terminal result.
