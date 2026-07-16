# Task 036 — Tabbed competitive-intelligence workspace

## Problem

The persistent report route is reloadable and visually clearer, but its sections still form one long page. Users need to switch quickly between the market verdict, rival dossiers, product battles, ad activity, and source evidence without losing context or scrolling through unrelated data.

## Outcome

- Add deep-linkable tabs for Overview, Competitors, Products, Ads, Evidence, and Methodology.
- Make the active tab part of the URL so refresh, browser Back, and shared links preserve context.
- Put the strongest decision and next action first in each tab; keep crawl mechanics inside Evidence/Methodology.
- Link competitor cards to their product battles, ad coverage, dossier evidence, and first-party source URLs.
- Link product pairs back to the relevant competitor and both product sources.
- Show observed, inferred, limited, and unavailable states consistently instead of raw JSON or empty panels.
- Preserve English/Arabic direction, keyboard tab semantics, mobile usability, and zero horizontal overflow.

## Acceptance criteria

1. Six tabs are keyboard-accessible and use correct tab/list/panel semantics.
2. `?view=overview|competitors|products|ads|evidence|methodology` controls the active view; invalid values fall back to Overview.
3. Reload and browser Back preserve the chosen view.
4. Competitor, product, ad, and evidence links cross-reference the correct report entities without guessed relationships.
5. Each primary tab starts with no more than three decision-oriented summary signals before detail.
6. Product cards retain both source URLs, verdict/confidence, and observed public prices when available.
7. Ads never imply zero activity when coverage is limited or unavailable.
8. English/Arabic desktop and mobile browser QA passes with no horizontal overflow.
9. Full tests, build, lint, Go tests, strict Fable review, exact deployment, real saved-report QA, and Fable merge pass.

## Data boundaries

Tabs reorganize the saved report; they do not strengthen evidence or convert historical observations into current facts. Every displayed relationship must come from a stored source-linked block, and coverage gaps remain visible within the relevant tab.

## Implementation and validation

- Replaced the long saved-report snapshot with URL-backed Overview, Competitors, Products, Ads, Evidence, and Methodology panels.
- Added keyboard tab semantics, browser history support, Arabic/English controls, entity cross-links, public source links, and explicit observed/inferred/limited/unavailable states.
- Validated against the saved `noororganicfood.com` public-data report: 2 competitors, 3 source-linked product battles, 3 advertiser coverage records, and 49 source-linked claims rendered from D1.
- Desktop and 390px mobile browser QA found zero horizontal overflow. Reload, Back, Arrow-key navigation, Arabic direction, repaired Arabic product text, exact competitor-to-product anchors, and six product source links passed.
- Strict Fable review found and blocked two edge cases: asynchronous fragment targets and RTL Arrow-key direction. Client-side cross-link routing now preserves the saved D1 document, scrolls after the destination panel renders, and reverses horizontal Arrow-key movement in RTL.
- Automated validation: build/typecheck, 178 tests, lint with no errors, and both Go modules pass.
