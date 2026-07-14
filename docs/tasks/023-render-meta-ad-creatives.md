# Task 023 — Render real Meta ad creatives

## User problem

The report currently reduces ad intelligence to small status chips and links, while creative cards are hidden inside competitor dossiers and appear only for one provider-specific payload. A user cannot scan the report and immediately understand which competitor is advertising, what the ad says, what it looks like, when it started, or which company-owned Page was attributed.

## Scope

- Add a top-level Ads chapter after Product Comparison.
- Render verified Meta creative records directly in the report, not only as outbound links.
- Preserve exact advertiser attribution to a Facebook Page linked from the company website.
- Carry the public fields the provider exposes: advertiser/Page, body, title/caption, CTA, media preview, destination URL, delivery dates, status, placements, observed date, and direct public record URL.
- Group duplicate placements without hiding how many public records support a concept.
- Show access limitations and empty scoped checks as coverage states; never translate them into a claim of zero advertising.
- Provide English and Arabic labels and responsive layouts without horizontal page overflow.

## Acceptance criteria

1. A verified provider creative is visible in the top-level report without opening a dossier.
2. Each creative card contains the public creative itself when available and identifies the exact advertiser Page.
3. Media URLs, destination URLs, and direct record URLs are rendered only when they are safe HTTP(S) URLs.
4. Provider records for another Page are discarded.
5. A Meta API record that exposes only copy and an ad ID still renders as a truthful copy-only creative card.
6. No ad spend amount is invented or implied.
7. Empty, limited, pending, and verified states remain visibly distinct.
8. Automated tests cover normalization, attribution, grouping, rendering, Arabic labels, and responsive overflow guards.
9. The task is validated with a real public advertiser result before completion.

## Data boundaries

- Metapi is a temporary unofficial exact-Page collector. Its records must link back to public Meta ad records and remain visibly identified as provider-observed evidence.
- The official Meta Ads Archive endpoint has country and ad-category coverage restrictions. A blocked or empty query is not proof of no advertising.
- Exact spend is not publicly observable for ordinary commercial ads and must not be shown.

## Implementation plan

1. **Widen and normalize provider records in `app/lib/ad-intelligence.ts`.**
   - Request the official Meta fields `id`, `page_id`, `page_name`, `ad_creative_bodies`, `ad_creative_link_captions`, `ad_creative_link_titles`, `ad_creative_link_descriptions`, `ad_delivery_start_time`, `ad_delivery_stop_time`, `ad_snapshot_url`, and `publisher_platforms`.
   - Retain the equivalent Metapi fields documented in its Tyver response: advertiser Page ID/name, bodies, captions/title/description, CTA, image/video preview, destination, snapshot URL, delivery start/stop, languages/countries/platform data, and provider record ID.
   - Cap body at 420 characters, headline/caption/description at 160, CTA at 80, Page name at 120, dates at 32, and list values at six. Missing optional fields stay absent; copy-only records remain renderable.
2. **Make Page attribution deterministic before rendering.**
   - Prefer a numeric Page ID present in the first-party Facebook link or resolved from that linked profile.
   - If Facebook does not expose the ID, run one bounded Metapi keyword identity probe. Accept a candidate Page ID only when records provide a destination/caption on the company domain and the returned Page name overlaps the first-party brand or linked Facebook slug. Require one unique candidate ID; ambiguous IDs produce `access-limited`.
   - Run the exact advertiser query with that ID. Discard every record whose `provider_page_id` differs before normalization/grouping. Report discarded-record counts in coverage; never treat them as activity.
3. **Apply URL safety at normalization time.**
   - Media must use HTTPS and a Meta-owned delivery host (`fbcdn.net`, `fbsbx.com`, or a `facebook.com` subdomain). The browser loads it directly: no proxy, download, persistence, or cache. A failed image is hidden and leaves a labeled media-unavailable fallback.
   - Destinations must be public HTTP(S), contain no credentials, and must not resolve to localhost/private-name syntax. Unwrap `l.facebook.com/l.php?u=` once and validate the target. If absent/unsafe, omit the destination action.
   - Direct records must be official Meta Ads Library record/snapshot URLs; otherwise build the canonical record URL from a numeric provider ID.
4. **Group without corrupting counts.**
   - Group by exact Page ID plus normalized body, title/caption, CTA, and destination host/path. Raw record IDs remain deduplicated.
   - A group stores raw placement count, all observed platform labels, earliest start, latest stop, and a representative safe media/record URL.
   - UI labels distinguish `N active records` from `M creative concepts`; neither count is called spend or impressions.
5. **Map provider outcomes to explicit states.**
   - `pending`: the client `/api/ads` request is in flight.
   - `verified-active`: at least one exact-attributed public record normalized successfully.
   - `no-verified-result`: a successful exact-Page query returned zero records in this country/status scope.
   - `access-limited`: provider key missing, country missing, Page unresolved/ambiguous, HTTP/auth/rate/timeout failure, only cross-Page records, or records without usable public IDs.
   - Give every state distinct English and Arabic copy; never use “no ads” for limited coverage.
6. **Keep spend out of the feature.**
   - Task 023 does not render spend, reach, or impression numbers. A later task may show a provider-returned public transparency field verbatim with region/methodology labels, but this implementation never estimates or ranges spend.
7. **Add the visible chapter in `app/page.tsx` and responsive styles in `app/globals.css`.**
   - Insert `#ad-activity` as chapter 04 after Product Comparison; renumber Rival Dossiers to 05 and Evidence & Coverage to 06.
   - Add the rail anchor/kicker and a top-level company-by-company creative feed with advertiser identity, summary counts, grouped cards, dates/platforms/status, observed date, safe actions, and coverage states.
   - Keep dossier pulses as compact links into `#ad-activity` instead of duplicating the full cards.
   - Use `minmax(0, 1fr)`, `min-width: 0`, `overflow-wrap: anywhere`, bounded media aspect ratios, and a single-column layout at 700px. RTL uses logical properties; no fixed-width content or URL text may expand the page.
8. **Test the boundaries before publishing.**
   - Add named cases in `tests/ad-intelligence.test.mjs`: `normalizes the complete bounded Metapi creative`, `renders an official copy-only record as a concept`, `discovers one exact Page from first-party domain evidence`, `rejects an ambiguous identity probe`, `counts and discards cross-Page records before grouping`, `merges duplicate placements and delivery ranges`, `rejects unsafe media and destination URLs`, `maps exact empty and provider failures to different states`, `never leaks provider secrets`, and `keeps the identity-plus-exact workflow bounded`.
   - Add named cases in `tests/rendered-html.test.mjs`: `adds the top-level Ads chapter and renumbers downstream anchors`, `renders the English and Arabic ad-state labels`, `renders creative copy and the media-failure fallback without opening a dossier`, `offers only safe destination and public-record actions`, `omits spend claims`, and `includes the mobile overflow guard classes`.
   - Preserve the existing route and fixture-leakage regression checks.
9. **Validate and record real public evidence.**
   - Always validate `myjam.co.uk` and its automatically accepted rivals because that is the user’s report. This run proves that every returned state is correctly scoped and attributed; a genuine exact-Page empty result is valid evidence for the empty state but does **not** satisfy the verified-creative requirement.
   - Always run a separate active control, beginning with `nike.com` and then the Metapi-documented MINISO advertiser if Nike cannot be exactly attributed. The control must produce `verified-active`, a numeric exact Page ID, at least one public ad record, at least one rendered concept, and grouped placement evidence when duplicates exist. A control company is never inserted into the MyJam customer report.
   - Record advertiser Page ID/name, raw record count, grouped concept count, public archive URLs, media/destination presence, discarded count, scoped country, observed time, provider, and ads-call latency in `docs/tasks/023-live-evidence.json`.
   - Record both the MyJam report result and the separate active-control result. Completion requires at least one real verified control creative plus a truthful MyJam coverage result, full tests/lint, exact private deployment, and strict Fable 5 PASS.

## Validation record

- Fable 5 strict plan review: `PLAN_PASS`; the reviewer confirmed the exact-attribution, safety, state, rendering, responsive, and real-control validation plan resolved its blockers.
- Local implementation validation: typecheck passed, production build passed, lint passed, and 98/98 automated tests passed on 2026-07-14.
- Browser visual validation: pending; the in-app browser runtime failed during connection setup and is not counted as passed.
- Real-data validation, exact private Sites deployment, strict implementation review, and PR merge: pending.
