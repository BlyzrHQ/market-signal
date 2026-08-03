# Task 096: same-domain homepage host recovery

## Problem

A fresh report for `babanuj.com` fails before product enrichment because the
scanner receives HTTP 403 from the apex homepage while the same public store is
served from `https://www.babanuj.com/`. The saved report consequently contains
mostly sitemap-only primary records without images or prices.

## Scope

- Try only the submitted host and its exact apex/`www` sibling.
- Keep every request HTTPS-only, SSRF-checked, and constrained to the same
  canonical domain.
- Resolve and obey robots policy before fetching the recovery host. An explicit
  robots denial or HTTP 429 remains terminal and is never routed around.
- When recovery succeeds, use the serving host for sitemap and page expansion.
- Expose a provenance gap describing the host recovery.
- Validate the complete report using row-level primary image and price coverage;
  a successful single-product enrichment request is not sufficient.

## Fable 5 architecture decision

Fable 5 approved bounded same-canonical host recovery. It distinguished a
homepage 403 (host availability) from a robots.txt refusal (crawl policy), and
required policy-first recovery, no user-agent cloaking, no arbitrary host
enumeration, no recovery after throttling, and rebasing all downstream URLs onto
the successful host.

## Acceptance criteria

1. Apex homepage 403 plus an allowed `www` robots policy and HTML homepage
   succeeds, with requests bounded to the two homepage hosts.
2. Explicit robots `Disallow: /` prevents both homepage requests.
3. HTTP 429 and off-domain redirects do not trigger host recovery.
4. Sitemap and expanded product URLs use the successful recovery host.
5. Existing crawl, robots, type, build, and lint tests pass.
6. A fresh live `babanuj.com` report completes and its product-comparison rows
   are measured for primary images and numeric prices. Missing public evidence is
   reported honestly and is not replaced with fixture data.
