# Task 030 — Parked-domain recovery

## Problem

`noororganic.com` currently serves a 114-byte shell that sends browsers to `/lander`; that path redirects to a GoDaddy/Afternic domain-for-sale page. A crawler that treats the empty shell as a company homepage can produce a misleading report, while a transient fetch failure can surface only a generic crawl error. Search also finds multiple plausible active businesses with related names, so silently switching the submitted domain would risk analyzing the wrong company.

## Scope

- Detect first-party parked-domain evidence without executing page scripts or following off-domain commercial landing pages.
- Stop competitor discovery when the submitted primary domain is parked.
- Return a specific, truthful failure state rather than a generic crawl failure or fabricated company report.
- Present likely active-domain alternatives as user-selectable suggestions; never switch domains silently.
- Keep the exact submitted domain, source evidence, and confidence boundary visible.

## Acceptance criteria

1. A Noor-style homepage that redirects to `/lander`, whose same-domain lander redirects to a recognized domain-for-sale provider, is classified as parked.
2. A parked primary domain does not proceed to competitor discovery or product comparison.
3. The API returns an explicit parked-domain error and at most three likely-domain suggestions, each backed by its public search source URL.
4. The UI renders each suggestion as a button that reruns the scan only after the user selects it.
5. Normal operational domains continue through the existing crawl path unchanged.
6. Tests, build, lint, and both Go modules pass.
7. Fable 5 returns a strict PASS, and production verification confirms the Noor parked-domain state plus a successful active-domain alternative.

## Data boundaries

- A related search result is a suggestion, not proof that it is the same company.
- The product must never silently replace the submitted domain.
- Off-domain parking destinations are evidence of domain state only and are never treated as company content.
- Parking classification is limited to an explicit provider allow-list; a generic off-domain redirect is not enough.
- No fixture result may appear as a live customer result.

## Validation

- `npm test`: 144/144 tests passed, including the production build and TypeScript check.
- `npm run lint`: passed.
- `go test ./...`: passed in `cli/` and `contracts/`.
- Real local scan of `noororganic.com`: HTTP 409 with `code: parked-domain`, GoDaddy/Afternic evidence, and no company report.
- Real local scan of the user-selectable active suggestion `noororganicfood.com`: HTTP 200, five crawled pages, and 456 public catalog records.
- Claude Code review metadata confirmed `claude-fable-5`; strict review found no required changes and returned `FABLE_TASK_030_PASS`. Non-blocking follow-ups include direct HTTP-to-parking detection and broader same-brand alternative recall.
