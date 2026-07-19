# Task 046 — Persistent report tabs and price-basis clarity

## Outcome

Keep report section tabs available while a desktop customer scrolls a long report, and replace the ambiguous unavailable-price headline with a truthful explanation of what was and was not compared.

## User problems

- The desktop sidebar now follows the document correctly, but its tab list scrolls out of view on long Products reports.
- “No direct price comparison” is ambiguous when both public prices are visibly present. It sounds like no price difference exists, when the actual constraint is that the products are not verified as the same variant or measurement basis.

## Proposed behavior

1. Keep the desktop sidebar in normal document flow so its background continues for the report height.
2. Make only the six-button tab list sticky on desktop. Brand and report identity may scroll away; the section controls remain visible without introducing an independent sidebar scrollbar.
3. Preserve the existing compact sticky horizontal tab bar below the 64px route header at 1023px and below.
4. Split non-delta price states into:
   - an exact pair was approved by the server but the displayed currency or format could not be calculated by the presentation layer;
   - both prices observed but not like-for-like;
   - one public price observed;
   - neither public price observed.
5. When both prices exist without an approved pair, explicitly state that the numbers are real observations but no cheaper/more-expensive claim is made until size, variant, currency, billing basis, or included value aligns.
6. Keep exact percentage and currency-gap output restricted to the existing server-approved `priceComparison` pair.
7. When a tab is selected without a deep-link target, return the document to the top of the selected section.

## Acceptance criteria

- At 1280px, the tab list remains visible after scrolling at least 900px while the document scrolls and the sidebar does not gain an independent vertical scrollbar.
- The desktop tab list does not cover the brand or report identity at page top and remains keyboard accessible.
- At 1023px and 320px, the existing sticky horizontal tab bar remains below the route header with no document horizontal overflow.
- A row with two observed prices and no approved exact comparison says that prices were found but the comparison basis is unverified; it does not say or imply that no numerical difference exists or that the products are proven different.
- A non-null server-approved price pair that cannot be parsed by the presentation helper receives a neutral exact-pair state, never the unverified-basis state.
- One-price and zero-price rows receive distinct, understandable headlines.
- Exact same-product comparisons retain the current cheaper/equal percentage and gap behavior.
- English and Arabic copy remain available and direction-safe.
- Validate against saved Babanuj report `491371d12fcd46189eff5f12c5b98b58`.

## Data boundaries

- Presentation-only. Do not widen product identity or exact-price eligibility.
- Do not infer missing prices, convert currencies, normalize pack sizes, or calculate an exact delta for close substitutes.
- Do not add browser automation, private storefront APIs, or generic hydration-state parsing to the production crawler.

## Review and validation

Fable 5 blocked the first proposal because three states omitted a server-approved pair that the browser cannot parse, and because the proposed 1024px compact acceptance check contradicted the actual 1023px breakpoint. The revised plan adds the fourth neutral state, uses visible price strings as the observed-state source of truth, localizes state details instead of reusing the English saved verdict, corrects the breakpoint, and returns the document to the top on ordinary tab changes.

- Implemented desktop sticky-only tabs, ordinary tab scroll reset, and four truthful non-delta price states with localized panel details.
- `npm test`: 210/210 pass, including typecheck and production build.
- `npm run lint`: 0 errors; the two existing raw product-image warnings remain visible.
- `go test ./cli/... ./contracts/...`: pass.
- Strict Fable 5 implementation review: **PASS**. It verified that both proposal blockers were resolved, sticky geometry does not recreate an independent sidebar scroll, deep links retain anchor behavior, exact deltas are unchanged, and the new wording does not widen the claim.
- First production browser QA rejected the static sticky assumption: the tab list exposed `position: sticky` in computed CSS but still moved out of the viewport during document scroll. Fable's blocker re-review traced the cause to `body { overflow-x: hidden }`, which made `body` a non-scrolling sticky container. The root fix changes body overflow to `clip`, preserving horizontal containment without creating a scroll container; the original sidebar flex layout and compact behavior remain unchanged.
- Pull request, exact Sites deployment, and live browser verification remain pending.
