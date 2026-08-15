# Task 139 — Cross-language product-search leads

## Goal

Recover evidence-safe competitor discovery when an ecommerce catalog and the
seller search results use different languages, without converting inferred
translations into observed product facts.

## Live failure

The production Noor report
`01f32b59853f46dd9d107952e3f13eee` completed on 2026-08-15 after Task 138 was
deployed. It observed 242 first-party Arabic products but verified zero
competitors and published zero product comparisons. Product search generated
Arabic and inferred English queries, including `reishi honey 500g`, but source
recovery required the English result title/path to overlap lexically with the
observed Arabic product name. Noor's `/en/` product URLs redirect to the Arabic
storefront, so they are not English aliases and must not be represented as
such.

## Scope

- Preserve an atomic immutable lead tuple containing the exact primary product
  ID/source URL, one-product lane query, candidate domain/source URL, and
  inferential admission basis. Domain merging must never split or cross-pair
  those fields.
- Permit a cross-language search source to become an **inferred discovery
  lead** only when it is bound to that exact lane and is a first-party,
  non-listing product-detail URL on the candidate domain.
- Keep lexical title/path admission as the preferred observed path.
- Keep the lead provisional while crawling. It must not enter competitor
  blocks, memory, ads, summaries, or company facts before promotion.
- Require the exact seeded page—not another sitemap or catalog page—to yield a
  first-party Product with a finite positive price and supported currency.
- Run the existing AI-hybrid semantic judge on that exact pair before entity
  verification. Require `same_product` or `close_substitute`, confidence of at
  least 0.80, complete output, and all existing identity, quantity, GTIN,
  accessory, generic-container, domain, and region vetoes.
- Pin a promoted exact pair into the later report matcher so plan truncation
  cannot silently omit the evidence that established the competitor.
- Never store an inferred translation as an observed alias, source claim, or
  product identity.
- Keep publishers, marketplaces, category/collection pages, search pages,
  social pages, and the primary brand excluded.

## Validation

- Focused discovery and competitor-verification tests cover direct lexical
  recovery, cross-language lane binding, candidate-domain binding, product
  detail path admission, listing/category rejection, wrong-lane rejection,
  missing/invalid price rejection, and exact-pair category admission.
- Full test, build, typecheck, and lint pass.
- Strict review returns no blockers on the exact PR head. Fable 5 remains the
  preferred reviewer; if its observable session limit persists, use the
  required independent Codex fallback reviewers and record that fact without
  claiming Fable approval.
- Deploy Trigger before the VPS exact approved commit.
- A fresh `noororganicfood.com` production report verifies at least one rival
  and publishes at least one comparison with a finite positive
  supported-currency rival price.

## Boundaries

- Search queries and model summaries are inferred routing aids, not evidence
  and not category-scoring terms.
- A search result alone cannot become a verified competitor or a published
  match.
- Existing source, quantity, GTIN, identity, region, and price-integrity gates
  remain in force.

## Review and validation log

- Fable 5 was requested at 2026-08-15 06:45 +03:00. Claude Code returned the
  observable session-limit message `You've hit your session limit · resets
  9:50am (Africa/Cairo)`. No Fable review is claimed for this task yet.
- Two initial independent Codex reviewers returned blockers around atomic lead
  provenance, pre-verification semantic judging, exact-page price evidence,
  and plan-limit pinning. The implementation was revised around those findings.
- Two fresh independent high-risk fallback reviewers then found blockers around
  bounded-catalog pin retention, listing/search route admission, inference-only
  deterministic fallback, identity-bearing URL parameters, ambiguous variants,
  exact-pair provenance, and global pin assignment. Every finding was addressed
  with adversarial regression coverage; re-review is still required.
- The final discovery and network suites pass 64 tests. The full repository command passes
  both typechecks, production build, and 728 tests with zero failures after
  reviewer-requested input and provenance hardening.
- The latest adversarial pass rejects multilingual listing routes, preserves
  non-tracking identity query parameters, rebinds publication provenance to
  the exact accepted lead, rejects duplicate catalog IDs/domains, and rejects
  conflicting one-to-one pins instead of silently dropping them.
- A subsequent strict review also reproduced nested listing pagination,
  provisional gap-URL leakage, partial mixed-pin admission, and private or
  credential-bearing product sources. Those paths now fail closed with direct
  regression coverage.
- A further adversarial pass extended the same boundaries to mapped-loopback
  search URLs, credential-bearing search evidence, additional translated
  listing terms, and non-array pin payloads.
- The final resource and publication pass rejects localized search-result
  routes before either admission path, applies the generic-container veto to
  pinned pairs, and stream-bounds the authenticated matching request before
  JSON parsing.
- Product-lane model summaries now use the same listing gate as direct search
  sources, including French, German, Italian, Dutch, Spanish, and Portuguese
  result-route markers.
- All discovery lanes now reject compound localized listing segments and
  pagination query keys. Public URL validation covers private IPv6 and NAT64
  literals, and production fetches preflight cached A/AAAA answers so every
  resolved address must be public.
- Inferred leads require a terminal product-container path. DNS answers are
  uncached and must remain identical and public before and after connection;
  response bodies are streamed and cancelled at their byte ceiling.
- Compound and multilingual search/listing routes are rejected before the
  generic HTML product-detail fallback.
- Nested catalog arrays are normalized from bounded prefixes, product IDs must
  be globally unique, exact-page attributes participate in ambiguity checks,
  and every pinned assignment requires semantic confidence of at least 0.80.
- Merged observed company evidence cannot publish provisional inferred search,
  source, evidence, or matched-product fields; private lead URLs remain crawl
  seeds only until exact-pair promotion.
- ESLint reports zero errors and the two pre-existing `no-img-element`
  warnings in the design lab and report page.
