# Task 037 — Bilingual identifier-first product matching

## Problem

The current hybrid matcher embeds and judges product prose, but product identity is still flattened into names and free-form attributes. Arabic diacritics and letter variants, Arabic-Indic digits, bilingual pack units, GTINs, SKUs, MPNs, brands, quantities, and variants are not represented consistently. That can starve strong Arabic↔English candidates or let the model overstate an exact match when an observed size or identifier conflicts.

## Outcome

- Add deterministic Arabic/English product-text normalization, including Arabic diacritics, common letter variants, tatweel, Arabic-Indic digits, decimal separators, and whitespace.
- Parse canonical mass, volume, and count/pack quantities from Arabic and English names and attributes.
- Extract validated GTIN, SKU, MPN, brand, quantity, and variant fields from JSON-LD without treating arbitrary numbers as identifiers.
- Prefer a guarded shared valid GTIN as observed identity evidence; contradictory valid GTINs are a hard veto.
- Use identifiers, bilingual normalized text, and canonical quantities in retrieval before the bounded embedding/model judge.
- Keep `same_product` strict: quantity, variant, and identifier conflicts downgrade or reject it, and exact price deltas remain unavailable unless the observed variant is compatible.
- Preserve explicit inference labels for all model decisions and retain lexical degradation when semantic/model services are unavailable.

## Acceptance criteria

1. Arabic and English forms of the same product family and pack size can enter the same bounded candidate pool without relying on model translation alone.
2. Arabic-Indic digits and Arabic unit spellings normalize to the same canonical quantity as their English equivalents.
3. Valid shared GTIN evidence can deterministically prioritize a pair; invalid/checksum-failing values cannot.
4. Conflicting valid GTINs, incompatible canonical quantities, and explicit variant contradictions prevent `same_product`.
5. SKU/MPN equality is only supporting evidence within a compatible brand/domain context and never global identity proof.
6. Existing SaaS/service matching and low-overlap controls remain safe and bounded.
7. Focused tests cover Arabic normalization, quantity parsing, identifier extraction/validation, retrieval inclusion, deterministic vetoes, and price-safety behavior.
8. Full tests, build, lint, Go tests, real bilingual-domain validation, strict Fable review, exact Sites deployment, live browser QA, and Fable merge pass.

## Data boundaries

Identifiers and quantities are observed only when extracted from a public product source. Deterministic normalization is not translation and does not invent attributes. A shared GTIN is identity evidence only after format and checksum validation. Model verdicts remain inferred, and historical values are not current evidence without a current source observation.

## Approved research basis

Task 032's verified Fable 5 research decision approved an identifier-first precision ladder: bilingual deterministic normalization, first-class identifiers and quantities, multilingual semantic retrieval, bounded small-model judging, and later D1-backed match memory. It rejected image similarity as a core layer until a labeled benchmark identifies a residual visual error class.

## Validation record

- Fable 5 architecture gate: conditional `GO`. Binding constraints were adopted: the legacy `normalized()`/`makeId()` path remains byte-stable; GTIN extraction is restricted to explicit JSON-LD fields and requires GS1 mod-10 validation; canonical GTIN sets use 14-digit zero padding; GTIN conflicts compare set intersection; SKU/MPN evidence is brand-scoped and retrieval-only; quantity/identifier signals augment rather than filter semantic retrieval; quantity conflicts override identifier equality for exact-price safety; and SaaS plan behavior remains unchanged.
- Added a separate bilingual normalization layer for Arabic diacritics, tatweel, alef/ya/ta-marbuta variants, Arabic-Indic and extended digits, and decimal separators. Existing product IDs and `normalizedName` values are unchanged.
- Added exact bilingual mass, volume, count, and pack parsing, including retained ounce/pound support. Ambiguous multi-quantity strings return no canonical quantity.
- Added explicit JSON-LD GTIN/SKU/MPN/brand extraction, canonical GTIN validation, identifier-aware retrieval, deterministic GTIN/quantity vetoes, and stricter exact-variant price gating.
- Real saved-report replay used the public Noor Organic D1 snapshot: 40 Noor, 40 Blue Passion, and 40 Organic N More presentation records. Canonical quantities were recovered for 26/40, 40/40, and 40/40 respectively. With semantic retrieval deliberately unavailable, zero unsupported random pairs reached the judge after the quantity-only false-positive path was removed.
- Live first-party page check: Noor's current organic apple-vinegar page returned a source-linked 500 ml canonical quantity, KWD 3.850 public price, `Nour Foods` brand, and merchant-scoped SKU. The SKU was not treated as GTIN or global identity. Two current Blue Passion pages exposed malformed JSON-LD and remained visible extraction gaps; this task does not invent identifiers from prose.
- Initial strict Fable 5 implementation review passed at `64d2827`; typecheck/build, 191/191 tests, lint with zero errors, and both Go modules were independently rerun. Sites version 66 deployed that exact commit.
- Fresh production QA on Noor Organic assessed 74 first-party products and exposed a useful bilingual 500 ml organic apple-vinegar substitute with two source-linked prices and no unsafe direct delta. It also exposed two weak fiber-bundle versus flour-bundle rows, including duplicate localized rival URLs. Strict Fable live-usefulness review correctly returned `BLOCKERS`; the PR stayed draft and unmerged.
- The blocker fix canonicalizes locale-prefixed product routes before catalog and assignment deduplication, retains merged claim IDs, removes generic English/Arabic container words from identity tokens, rejects low-confidence inferred substitutes without deterministic identity, and prevents generic-container-only pairs from occupying a battle row. The matcher prompt version is now `ai-product-match-v4-useful-identity`.
- Regression coverage proves `/ar/products/x` and `/products/x` collapse into one rival, generic Arabic/English bundle pairs remain unmatched even after a high-confidence model verdict, low-confidence unsupported pairs remain unmatched, and one physical localized rival can occupy only one assignment.
- Automated validation after the blocker fix: build/typecheck and 195/195 tests pass; lint has zero errors and the two pre-existing `<img>` advisories; contracts and CLI Go tests pass.
- Strict Fable re-review, exact redeployment, fresh Noor browser QA, and merge remain pending.
