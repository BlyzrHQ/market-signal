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
- The latest discovery, verification, network, and persistence suites pass 81 focused tests. The full repository command passes
  both typechecks, production build, and 734 tests with zero failures after
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
  literals, and production fetches use fresh A/AAAA answers so every resolved
  and connected address must be public.
- Inferred leads require both a terminal product-container path and lexical
  support from the candidate path itself; search-result titles alone cannot
  turn translated listing pages into product leads. Unknown-language entity
  result paths are rebound to the first-party root before publication.
- DNS answers are uncached and every production HTTP connection is pinned to
  an exclusively public DoH-validated address while retaining the original
  hostname for TLS. Response bodies are streamed, distinguish exact-boundary
  completion from overflow, and cancel after observing at most one byte beyond
  their configured ceiling.
- The pre-review focused adversarial pass contained 50 passing tests, the full suite
  and production build pass, and a live production-path pinned fetch of `example.com`
  returned HTTP 200 with 559 bytes and no truncation. Exact-head strict
  re-review remains pending for the next commit.
- Two exact-head fallback reviewers then identified a title-only nested
  translated-listing bypass and the standard `64:ff9b::/96` NAT64 form of an
  embedded private IPv4 destination. Product search evidence now requires URL
  identity or an atomic translated-query binding, and IPv4-compatible, mapped,
  and well-known NAT64 addresses all inherit the embedded IPv4 public-address
  policy. The fresh full suite passes; exact-head re-review is pending.
- Product-detail containers are now accepted only at the root or behind
  locale-shaped path prefixes, closing nested Czech and Polish search-folder
  variants. Translated query/path inference is evaluated independently from a
  provider title match, preserving legitimate German-path recovery. The fresh
  full suite passes again; exact-head re-review remains pending.
- The network re-review found further RFC 2765 translated and 6to4 forms.
  IPv6 now fails closed to the allocations in the IANA IPv6 Global Unicast
  Address Space registry (last updated 2025-10-10) after excluding
  embedded-IPv4, IETF special-assignment, documentation, and transition
  ranges. Literal and DoH-answer regressions reject unallocated `3000::/4`
  and former 6bone `3ffe::/16` space while retaining current Google and
  Cloudflare addresses.
- Product-detail admission now includes Arabic `منتج` / `منتجات`, Chinese
  `商品`, and Italian singular `prodotto` containers under the same root or
  locale-prefix structural rule. The exact-head focused suite passes 81/81,
  the full suite passes 734/734, the production build passes, and ESLint has
  zero errors with the same two pre-existing image warnings. Exact-head strict
  re-review remains pending.
- Exact-head security re-review caught a `/12` mask implemented as `/8`, which
  admitted reserved neighbors such as `2420::1`, `2640::1`, and `2a20::1`.
  The allocation test now uses the correct `0xfff0` first-word mask and literal
  plus DoH-answer regressions cover every reported boundary. The full suite
  remains 734/734 and lint remains at zero errors; exact-head re-review is
  required on the correcting commit.
- Re-review then found that the compact allowlist omitted valid newer IANA
  allocations. The complete table now includes `2410::/12`, `2610::/23`,
  `2620::/23`, `2630::/12`, and `2a10::/12`, with positive literal and DoH
  boundary tests alongside the reserved-neighbor negatives. The focused
  network/persistence suite passes 32/32, the full suite passes 735/735, both
  typechecks and the production build pass, and lint remains at zero errors.
- Final network review demonstrated that organization-specific RFC 6052 NAT64
  and ISATAP routes cannot be classified safely from an IPv6 address alone.
  Because Market Signal is a domain-in product, direct IPv6 literals are now
  outside the accepted URL boundary and production HTTP fetches pin only fresh
  exclusively public IPv4 A answers. AAAA-only domains surface as coverage
  gaps instead of creating an ambiguous SSRF route. Focused multilingual,
  persistence, adapter, and network tests pass 88/88; the full suite passes
  736/736, both typechecks and production build pass, and lint has zero errors.
- Product re-review found that the initial AAAA-only boundary still collapsed
  to a generic request failure. DNS preflight now queries AAAA only after an
  empty A answer for classification, never for transport, and returns the
  typed user-facing reason that IPv6-only origins are unsupported. The page
  transport is not attempted. The network/persistence suite passes 34/34 and
  the full repository suite passes 737/737 with both typechecks, build, and
  zero lint errors.
- End-to-end messaging review then found the bounded retry and terminal report
  replacing that reason with generic unavailable copy. The same typed reason
  is now preserved only when both same-origin attempts agree, and it drives the
  domain-status explanation, summary, gap, and API error. The final focused
  crawl/network suite passes 29/29 and the full suite passes 738/738 with both
  typechecks, production build, and zero lint errors.
- Exact-head product re-review found that an IPv6-only submitted apex could
  still lose its specific reason when automatic `www` recovery failed with a
  generic DNS error. Endpoint failure selection now retains the submitted
  IPv6-only limitation in that case and otherwise reports the final attempted
  endpoint. The focused crawl/network suite passes 37/37, the full suite passes
  739/739, the production build passes, and ESLint has zero errors with the two
  pre-existing image warnings. Fresh exact-head reviews are required.
- Exact-head network/security review then found three blockers: runtime
  replacement of global `fetch` could bypass DNS pinning, an empty stream chunk
  could hide overflow after the exact byte boundary, and substring matching
  could preserve attacker-appended text as the IPv6-only reason. Production now
  always uses the captured platform fetch plus pinned transport unless a caller
  supplies an explicit dependency, crawl tests use explicit fetch and robots
  dependencies, the overflow probe skips empty chunks until EOF or a real byte,
  and typed customer copy requires the exact exported canonical constant. The
  node suite passes 741/741, both typechecks and the production build pass, and
  ESLint has zero errors with the same two pre-existing warnings. Fresh
  exact-head reviews are required after commit.
- The next security pass found that selected-product HTML and storefront adapter
  enrichment still used a separate raw-fetch implementation. That path could
  rebind after robots approval, buffered the full body before slicing, and did
  not cancel redirect bodies. It now uses the same fresh-DNS, pinned,
  stream-bounded public transport as crawling. Non-success bodies can be
  cancelled without reading, final same-origin redirect URLs remain available
  to identity validation, and explicit fetch/robots dependencies are confined
  to tests. The focused route, enrichment, transport, and storefront suites pass
  105/105; the integrated suite passes 742/742 with both typechecks and the
  production build; ESLint has zero errors with the two pre-existing warnings.
- Exact-head product re-review reproduced five additional listing-query forms
  (`offset`, `limit`, `cursor`, `start`, and `from`) that could otherwise carry
  a single structured product and be mistaken for a detail page. They now share
  the existing pagination/listing veto before lead admission and publication,
  with a regression for every reported form.
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
