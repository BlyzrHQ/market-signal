# Task 067 — Make Ads, Evidence, and Method actionable

## Customer problem

The saved report currently wastes three destinations:

- Ads repeats access-limit messages and links while hiding verified creative records already stored in the report.
- Evidence is a long crawl ledger that makes the customer interpret raw claims instead of understanding why a decision is trustworthy.
- Methodology promotes internal model/provider names instead of explaining limits in business language.

The result is truthful but not useful. A customer should immediately see what a competitor is advertising, what remains unverified, which source supports a decision, and what to do next.

## Fable 5 product decision

The verified Fable 5 session first identified that `creativeConcepts` are produced by the ad pipeline but dropped by the dashboard. After a challenge against the user's direct feedback, Fable revised the information architecture:

1. Use five top-level views: Overview, Competitors, Products, Ads, and Evidence & Method.
2. Preserve `?view=methodology` as a legacy alias that opens Evidence & Method at `#method`.
3. Merge the truth legend, crawl coverage, investigation gaps, and plain-language method explanation into Evidence & Method.
4. Render verified ad creative concepts directly in Ads with exact-Page attribution, copy, safe media, dates, placements, and source links.
5. When no active creative is verified, show a compact verification queue with distinct per-platform reasons, official searches, and the next action. Never describe limited coverage as "no ads."

## Scope

- Restructure report navigation and gracefully map the retired methodology view.
- Render saved verified creative concepts in the Ads view.
- Replace repetitive zero-verified advertiser cards with an actionable verification queue.
- Merge Evidence and Methodology content into one customer-readable view.
- Keep evidence, confidence, gaps, and coverage boundaries accessible.
- Add focused route/rendering regression tests.

## Data boundaries

- No new ad activity, spend, reach, impressions, or creative details may be inferred.
- Only stored `verified-active` creative concepts may render as active ads.
- Media is loaded directly from allowed HTTPS Meta hosts and is not persisted or proxied.
- Missing or access-limited coverage remains explicit and is never evidence of absence.
- Provider/model identifiers may appear only as secondary technical detail, not as a headline or decision.

## Acceptance criteria

1. The sidebar shows five views and retains keyboard, compact, RTL, and terminal-domain behavior.
2. Legacy `?view=methodology` resolves to Evidence & Method at `#method`; existing Evidence and Ads anchors still work.
3. Evidence & Method presents the truth legend, source-linked claims, coverage/gaps, and a plain-language method explanation in that order.
4. A verified-active saved result renders at least one creative card without another click, including exact advertiser identity and safe source links.
5. A zero-verified result renders one actionable verification queue with distinct reasons, official platform searches, and recommended actions rather than repetitive status cards.
6. Ads never claims spend/reach/impressions or uses "no ads" for limited coverage.
7. Relevant tests, lint, and build pass.
8. The exact deployed commit is verified against a real MyJam saved report and a verified-active control when available.

## Validation record

- Fable 5 product decision: revised five-tab information architecture; creative concepts restored; zero-verified verification queue; Evidence and Method merged.
- Real saved MyJam baseline (`2f17bfc19dd64415bb6f12a10155f8df`): 7 companies, 21 official platform searches, 0 verified-active signals, 133 evidence claims, 3 gaps, and 7 coverage records.
- `npm.cmd run lint`: no errors; two existing/raw-media `no-img-element` warnings because public product/ad media cannot use a fixed Next image host allowlist.
- `npm.cmd test`: PASS — typecheck, production build, and 317 tests.
- Fable 5 strict review round 1: BLOCK. Resolved all three blockers by restoring direct record links for verified Google/TikTok activity, requiring HTTPS for Meta creative media, and opening collapsed evidence for deep links and print/export. Also hardened ad destinations against additional private-network ranges and added meaningful creative image alt text.
- Fable 5 strict review round 2: PASS at `f525c047311f2740f61fb527d8b90cef33c9c23d`; the reviewer independently reran all 317 tests, the production build, and lint.
- Sites v108 deployed the reviewed code commit successfully. Live MyJam Ads verification found five tabs, seven company review rows, 21 official searches, no false zero-ad claim, and no desktop or 390 px mobile horizontal overflow.
- Live Evidence & Method verification found seven collapsed company groups representing all 133 saved claims, three explicit investigation gaps, a closed technical record, working source-group deep links, and a working legacy `?view=methodology` redirect to `?view=evidence#method`.
- Verified-active rendering remains covered by automated normalization/rendering tests and the real Nike control recorded in Task 023 (18 exact-Page records grouped into nine concepts). No currently saved verified-active customer report was available for a second live route check; this limitation is explicit and no fixture was presented as customer data.
