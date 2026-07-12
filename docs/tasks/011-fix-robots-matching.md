# Task 011: Fix robots matching and crawl errors

## Problem

`https://myjam.co.uk/` declares `Allow: /`, but its Shopify robots file also contains wildcard query rules such as `Disallow: /*?*preview_theme_id=*`. The old parser collapsed that wildcard rule to `/` and incorrectly rejected the homepage. The API then hid the robots reason behind a generic crawl failure.

## Acceptance criteria

- Evaluate `*` and terminal `$` as robots patterns rather than conservative prefixes.
- Apply the most specific matching user-agent group.
- Apply longest-rule precedence, with `Allow` winning equal-specificity ties.
- Keep empty `Disallow` directives non-blocking and preserve sitemap discovery.
- Crawl `myjam.co.uk` successfully from the deployed endpoint.
- Return the first concrete gap reason when a primary crawl genuinely fails.
- Pass build, lint, regression tests, strict Fable 5 review, deployment verification, and PR merge gates.

## Validation

- Full suite: 17 tests pass; lint and diff checks pass.
- Rebuilt local production crawl: `https://myjam.co.uk/` succeeds with 5 public pages and 4 attributable catalog records instead of the false robots rejection.
- Strict Fable 5 verdict: PASS with no reproducible blockers after 11 additional adversarial probes.
