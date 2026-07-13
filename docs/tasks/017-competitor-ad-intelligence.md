# Task 017 — Competitor ad intelligence

## Goal

Show what the primary company and each verified product competitor are currently doing in Meta ads while official API approval is pending, using exact attributable Facebook Page identities rather than noisy keyword matches.

## Data method

1. Accept a Facebook profile only when it is linked from the company's own crawled website.
2. Resolve that public profile to an exact numeric Facebook Page ID.
3. Query Metapi's advertiser endpoint with that Page ID. Never use Metapi keyword results as evidence.
4. Reject every returned record whose Page ID differs from the requested advertiser.
5. Group duplicate placements into message concepts using normalized copy, caption, and CTA.
6. Preserve direct Meta Ad Library record links, observation time, Page attribution, dates, and available creative media.

## Product outcome

- Compare the primary company's observed Meta activity with each verified rival.
- Show active placements separately from unique message concepts.
- Summarize the rival's actual public offer/message and make a grounded next-move recommendation.
- Keep empty results scoped to the exact Page and country; never imply global inactivity.
- Label Metapi as an unofficial temporary provider and never present exact commercial spend.

## Acceptance

- The primary and verified competitors are scanned when they expose an attributable Facebook profile.
- Missing or unresolvable profiles produce a visible coverage state, not a fabricated zero.
- Keyword searches and cross-advertiser results cannot become evidence.
- Duplicate placements collapse into concise message concepts with direct evidence links.
- API keys remain server-side, absent from URLs, responses, logs, commits, and test snapshots.
- Tests cover attribution, exact-ID requests, polling, deduplication, cross-advertiser rejection, zero results, failures, and token leakage.
- A real MyJam run confirms its exact Page zero against Meta's public library and attempts the same exact method for every verified competitor.
- Build, lint, tests, strict Claude/Fable review, PR, and Sites deployment complete before merge.

## Review decision

Claude returned `PASS` for the architecture provided that only company-attributable Page IDs are accepted, records are queried by exact advertiser ID and deduplicated, the provider remains explicitly unofficial, and exact spend is omitted. The remaining risk is contractual/provider reliability, so the adapter is temporary and replaceable.

Fable 5 then completed a strict read-only diff review and returned `FABLE_GATE: PASS`. It found no blocking attribution, false-zero, secret-leakage, comparison-order, or UI regression defects. Its non-blocking cautions were the provider polling budget on tight serverless hosts, expiring Meta CDN previews, fragility of Facebook HTML identity fallback, and availability/terms risk from the unofficial provider.

## Validation evidence

- `npm test`: 41/41 passing, including exact advertiser-only requests, duplicate placement grouping, numeric Page IDs, unsafe cross-advertiser rejection, scoped zeros, and token non-disclosure.
- `npm run lint`: passing.
- Production build: passing.
- Crawl route plus UI TypeScript check: passing.
- Real MyJam check: company-linked `MyJam` Page `100063536817111`; no active Meta ad was observed for the exact Page in GB at the check time.
- Real close-market checks: Quality Foods Online, Tariq Halal, and The Halal Food Shop resolved to attributable exact Pages and returned scoped zero active results; Red Rickshaw did not expose an attributable Facebook profile on its public homepage and remained access-limited.
- Real active control: exact Page `1148679501654585` returned 44 accepted placements grouped into 5 distinct message concepts. Every accepted result matched the requested Page ID.
