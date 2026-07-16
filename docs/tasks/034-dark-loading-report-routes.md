# Task 034 — Dark loading and persistent report routes

## Outcome

- Replace the narrow light canvas with a dark, full-width responsive product shell.
- Give every submitted domain an immediate `/reports/{publicId}/loading` URL.
- Show a compact animated market radar and only factual messages that were successfully persisted as report events.
- Keep the existing client-orchestrated phases alive while the loading URL is displayed, then navigate to `/reports/{publicId}` after the D1 document save succeeds.
- Make the completed report URL reloadable from D1 without rerunning the crawl.
- If a loading URL is reopened, poll the durable run, redirect when complete, and show interrupted/failed states honestly.

## Acceptance criteria

1. The background fills the viewport at desktop and mobile widths without horizontal overflow.
2. Submission changes the URL to a unique loading route before crawling begins.
3. Loading messages correspond to persisted events; no fabricated percentage or fake company count appears.
4. Successful persistence navigates to a dedicated report URL.
5. Reloading the completed report reconstructs it from D1.
6. A storage failure never navigates to a report or claims completion.
7. English and Arabic controls remain usable and correctly directed.
8. Build, tests, lint, Go tests, Fable review, deployment, real-domain browser QA, and Fable merge pass.

## Scope boundary

This task establishes routes, dark presentation, and persistence-backed loading. Task 035 adds the final Overview, Competitors, Products, Ads, Evidence, and Methodology tab system and deep-link information architecture.

## Review record

- Fable 5 round 1: `VERDICT BLOCK`. It found incomplete Arabic route chrome, no safe cancel/back path, ungated stale-run navigation, save-failure URL stranding, an eternal no-document spinner, vertically clipped loading content, and an unsafe homepage-renderer import.
- Corrections: both routes use persisted locale and RTL/Arabic copy; cancel and popstate invalidate the active run; final navigation is gated by run identity and pathname; every failure resets the URL; running/failed/interrupted/schema states are explicit; loading scrolls vertically; the report uses an independent bounded snapshot renderer.
- Fable 5 round 2: `VERDICT PASS`. It independently ran the complete gate and confirmed every blocker was fixed. Three cosmetic/race observations remain non-blocking and are documented in the PR.
