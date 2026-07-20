# Task 059 - Market region integrity

## Problem

The Babanuj production report inferred a United States market but accepted `desertcart.in` and `desertcart.com.sa` as region-compatible competitors. Entity verification compared candidates only with the crawler's primary-site region. Babanuj's first-party text produced a broad/global crawl classification, while the market discovery phase had already resolved the actual target market to the United States. The global crawl label therefore bypassed the proven country mismatch.

## Outcome

Use the report's resolved target market when verifying discovered competitors. A country storefront in a different proven region must not be displayed as a same-market competitor merely because the primary site also exposes worldwide/global language.

## Proposed rule

- Resolve a verification market from the discovery result when it names a concrete country.
- Fall back to the primary crawl region when discovery is unknown or global.
- Keep genuinely global candidate companies compatible with a concrete target market.
- Reject a candidate whose first-party region is a different concrete country.
- Preserve unknown-region neutrality; missing evidence is not fabricated into a mismatch.
- Extend first-party region inference for India with `.in`, `en-IN`/`hi-IN`, structured `IN`/India addresses, INR/rupee, `+91`, explicit India text, and exact region-code parsing.
- Concrete country evidence outranks global marketing language. A `.in` storefront that says “worldwide” resolves to India; a `.com` company with no concrete country signal and genuine global language may remain global.
- Parse the model-produced discovery market through a strict exact country-name/ISO table after removing only the known `(inferred)` display suffix. Do not use substring guesses such as interpreting “South Africa” as Saudi Arabia.
- Record rejected candidates as investigation gaps with an explicit region decision that distinguishes the inferred target-market source from the observed/inferred first-party candidate region.

## Acceptance criteria

- A US target market rejects `.in`/India and `.com.sa`/Saudi candidate storefronts when their first-party crawl resolves those concrete regions.
- A US target market accepts a same-category US candidate.
- A US target market may accept a genuinely global candidate only when it has no concrete country evidence.
- A `.in` candidate with worldwide language resolves to India and is rejected for a US target; a `.com` candidate with only corroborating global language remains compatible.
- Unknown candidate regions retain the existing neutral behavior.
- A global or unknown discovery market falls back to the primary first-party crawl region.
- “South Africa” and other unsupported free text do not resolve through the strict discovery-market parser.
- The rejected India/Saudi candidates appear as investigation gaps containing the target-region and candidate-region provenance, not as verified competitors and not as a silent omission.
- Existing UK, SaaS-global, category, and product-overlap verification tests stay green.
- The exact implementation is reviewed by Fable 5, fully tested, deployed, and rerun against Babanuj before Task 57 continues.

## Data truth boundary

Market compatibility means evidence of serving the report's target market. Product-name overlap alone does not prove that an India- or Saudi-specific storefront competes for US customers. This task does not infer shipping availability from product presence and does not convert unknown regional evidence into a rejection.

A bounded fulfillment-origin phrase is operational evidence of market presence, not an observed market declaration. It remains an `Inferred` signal. Only a curated city/state origin bound to an operational shipping verb is accepted; country sourcing, import language, destinations, and casual place mentions are excluded. Its weight is exactly `4`: the minimum concrete score accepted by the existing region combiner, allowing it to outrank global marketing language without being tuned as stronger evidence than necessary.

## Status

Fable 5's first design review returned `BLOCK`: India was missing from the region model, candidate-side global language could repeat the bypass, discovery-market parsing was too loosely specified, and rejection provenance lacked a testable output. The revised design adopts all four requirements. Fable 5 then returned `PASS` on the revised design. Implementation and live verification are in progress.

## Review record

- Design: Fable 5 first returned `BLOCK`; the design was revised to add complete India evidence, concrete-over-global precedence, strict market parsing, and rejection provenance. Fable 5 then returned `PASS`.
- Implementation: Fable 5 returned `PASS` after inspecting the complete Task 59 diff and independently rerunning the focused and full tests. It confirmed the target-market override, India evidence, strict parser, neutral global/unknown behavior, and investigation-gap provenance.
- Remaining merge gate: publish the focused PR, deploy the exact implementation commit, and verify a fresh Babanuj production report before asking Fable 5 to merge.

### First live gate

Sites version 98 deployed the reviewed implementation. Fresh report `5c2fd3e098e242b1af72ec2e6e467c65` completed, but the live gate returned `BLOCK`: discovery resolved the market as `global`, while a previous Babanuj run had resolved it as United States. The primary crawl also remained global despite first-party metadata saying products are “shipped fresh from Houston,” so India and Saudi storefronts remained compatible. This nondeterminism proves the primary-crawl fallback must retain bounded operational locality evidence. Fable 5 returned `PASS` on the live-fix design after requiring city/state-only origins, verb-bound matching, inferred weight `4`, sourcing/destination negatives, and a conflicting-origin test.

Fable 5 then returned `PASS` on the live-fix implementation after independently rerunning the focused `24/24` and full `276/276` suites. It confirmed the curated origin table, nearest-`from` binding, negative sourcing/destination cases, concrete-over-global behavior, conflicting-origin neutrality, and documented inferred provenance.

### Second live gate

Sites version 99 deployed the fulfillment-origin fix. Fresh report `b77820f3cf4b480292673f8ceeda23ba` resolved the target market to United States and improved the useful output to six competitors and 26 product battles. The gate still returned `BLOCK`: `desertcart.com.sa` and `desertcart.com.eg` remained verified competitors. Their observed country-code TLD signals were diluted by mixed locale/currency/location page signals, the combined candidate region became unknown, and unknown neutrality bypassed the country mismatch.

Fable 5 returned `PASS` on a second live-fix design: candidate storefront market uses an observed supported country-code TLD signal when present, otherwise the combined first-party region. This evidence is derived from the existing crawler signal rather than reparsing domains in verification. A foreign ccTLD storefront genuinely serving the target market will move to a visible investigation gap; this intentionally favors precision over recall and is recoverable from the explicit gap. Vanity use of a supported ccTLD carries the same visible-gap risk. Unsupported generic TLDs remain neutral when no concrete combined region exists.

Fable 5 then returned `PASS` on the country-code storefront implementation after independently rerunning the focused `28/28` and full `280/280` suites. It confirmed that verification consumes the crawler's existing observed `tld` signal, the ccTLD takes precedence over unknown or conflicting combined page signals, same-market and generic-domain behavior remains unchanged, and investigation-gap reasons expose the storefront domain, first-party-observed country code, and combined-signal outcome. The remaining gate is a third Babanuj production run from the exact deployed commit.

### Third live gate

Sites version 100 deployed exact commit `0077b9fc22489bd19bfc9e92fe8c733c582dc621`. Fresh report `c697d2c98adb47ed9c56c9d78c214105` completed with a United States market, five verified competitors, four competitors with product overlap, and 17 accepted product battles across 62 assessed primary products. No India, Saudi Arabia, or Egypt Desertcart storefront appeared as a verified competitor. The foreign storefront discovered in this run, `desertcart.com.eg`, was retained as a visible investigation gap with the complete reason: target market `US` from discovery conflicts with the `EG` country-code storefront observed from first-party evidence, while its combined page signals resolved `GLOBAL`.

The product table rendered all 17 saved battle rows with 27/27 product images loaded and no broken image. Seven battles exposed both public prices, seven exposed one public price, and three exposed neither; the interface labels those gaps rather than fabricating a comparison. Advertising checked all six companies, reported zero verified active signals and three access-limited checks, and preserved the explicit warning that this is not proof of zero ads. This live gate is `PASS`; Fable 5's final merge-gate review remains required.

## Local validation

- `npm test`: `280/280` tests passed, including the production build and typecheck.
- `npm run lint`: no errors; one pre-existing `<img>` optimization warning in `app/components/product-design-lab.tsx`.
- Focused region and competitor verification tests: `28/28` passed.
