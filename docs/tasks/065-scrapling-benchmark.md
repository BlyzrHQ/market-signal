# Task 065 — Scrapling benchmark and adoption decision

## Objective

Determine whether [D4Vinci/Scrapling](https://github.com/D4Vinci/Scrapling) materially improves the missing product, price, or image evidence in saved report `4a7a83e3503e4c36b948381be40ac07a` for `myjam.co.uk`.

This task is an evaluation only. It does not add Scrapling to the production crawl path.

## Decision

**Reject production adoption for this failure mode.** Keep Scrapling as a candidate for a future, separately measured browser-fetch fallback only if ordinary HTTP fails on a representative blocked or JavaScript-only corpus.

Scrapling returned the same product evidence as ordinary HTTP on every tested rival URL and added zero prices and zero images. It completed faster in this ordered local run, but the standard request always ran first, so the timing is order-confounded and is not evidence of a causal Scrapling speed advantage. The linked report's missing-price problem is therefore an extraction and enrichment-budget problem, not a product-page fetch-transport problem.

## Production baseline

The live report was inspected on 2026-07-21:

- primary domain: `myjam.co.uk`
- primary products assessed: 70
- accepted product pairs: 29
- direct price deltas: 2
- selected-page enrichment gaps: 9
- primary images present in the table: 29/29
- rival images present in the table: 28/29

The dominant visible gap is price evidence. Several `mymeatshop.co.uk` pages retain an image but show `Price not observed`, while the report records a blocked or non-JSON WooCommerce Store API response.

## Method

The reproducible harness is [`scripts/benchmark-scrapling.py`](../../scripts/benchmark-scrapling.py). It pins Scrapling `0.4.11` in the setup instruction and tests the exact 29 rival product URLs selected in the saved report.

For each URL it runs two transports:

1. Python standard-library HTTP with a declared benchmark user agent.
2. Scrapling `Fetcher` with Chrome impersonation.

Both transports feed the same deliberately conservative extractor. A JSON-LD price counts only when the Product name matches the page's product heading. An HTML price counts only when it is inside the product summary and has one unambiguous positive amount and currency; sale markup uses the current `ins` price. Prices from related-product widgets do not count. The harness records robots permission, status, body bytes, time, title, price, currency, image, extraction source, and error.

The harness reads each domain's public robots file with its declared benchmark user agent, evaluates every product route against the parsed directives, and stops before product requests if a route is not allowed. It fails closed when robots.txt cannot be fetched or parsed. Dynamic and stealth fetchers were not run because static HTTP returned every requested page and the same 20 unambiguous prices as Scrapling. Anti-bot bypass is out of scope and would conflict with the public-data contract.

The blocked WooCommerce Store API endpoint itself was not benchmarked. That is a limitation of this test, but it does not change the decision: the already-permitted ordinary product HTML contains the missing evidence, so parsing that evidence inside the existing runtime is smaller and safer than introducing a Python transport to try to unblock a redundant endpoint.

## Results

Raw per-URL output is committed in [`065-scrapling-benchmark-results.json`](./065-scrapling-benchmark-results.json).

| Metric | Ordinary HTTP | Scrapling Fetcher | Incremental gain |
| --- | ---: | ---: | ---: |
| Pages | 29 | 29 | 0 |
| HTTP 200 | 29 | 29 | 0 |
| Unambiguous attributable prices | 20 | 20 | 0 |
| Images in the minimal benchmark extractor | 7 | 7 | 0 |
| Errors | 0 | 0 | 0 |
| Median fetch time, ordered local run | 0.684 s | 0.466 s | Not causal; standard ran first |
| Total fetch time, ordered local run | 65.071 s | 46.868 s | Not causal; standard ran first |

The image count is not the production image baseline. The benchmark extractor intentionally implements only Product JSON-LD and OpenGraph image recovery so transport differences remain isolated. The live product table already showed 57 of 58 possible row images.

Representative production-missing observations recovered by both transports:

- `https://mymeatshop.co.uk/product/white-onion/` — GBP 1.14
- `https://mymeatshop.co.uk/product/halloumi-cheese-250g/` — GBP 4.35
- `https://mymeatshop.co.uk/product/red-onion/` — GBP 1.58
- `https://mymeatshop.co.uk/product/mild-red-pepper-paste-700g/` — GBP 5.39

Eight WooCommerce pages were intentionally left without a benchmark price because the scoped product area exposed multiple distinct amounts without a single current sale-price marker. The Oasis lamb-leg page was withheld because its JSON-LD name did not meet the strict page-title identity rule and it exposed no recognized product-scoped HTML fallback. The benchmark does not guess across variant, range, or identity ambiguity. Both transports produced the same accepted and rejected set.

## Root cause in the current pipeline

The selected product page is already fetched as HTML. Market Signal currently treats Product JSON-LD and OpenGraph offers as authoritative. If no price is found, it calls the WooCommerce Store API. On `mymeatshop.co.uk`, that API returns 403 or non-JSON content.

The ordinary product HTML still contains a product-summary-scoped price, but the current product extractor does not promote that value to an authoritative product-page offer. The pipeline therefore reports a Store API gap even though the already-fetched page contains attributable evidence.

Coverage is also bounded independently of transport:

- primary price targeting is capped at 6 products;
- selected-page enrichment is capped at 24 pages;
- the linked report contains 29 pairs and 70 assessed primary products.

Scrapling cannot remove those application-level caps.

## Runtime and contract boundary

Market Signal runs TypeScript in Cloudflare/Sites and Node tasks in Trigger.dev. Scrapling is Python. Production adoption would require a new Python service or container, authenticated calls from Trigger, independent observability, deployment, scaling, timeout, and rollback behavior.

If a future benchmark justifies that service, its boundary must be:

- invoked only after the existing public fetch path records an explicit transport or JavaScript-rendering gap;
- gated by a feature flag and per-domain rate limit;
- domain-pinned and bounded by response bytes, time, and redirect count;
- robots-compliant and subject to applicable terms;
- limited to ordinary or browser rendering; stealth/CAPTCHA/control bypass remains prohibited;
- required to return source URL, observed time, method, and gap state;
- automatically fall back to the existing pipeline when unavailable.

## Adopt and kill criteria for any future trial

Do not adopt based on this report. A future trial needs a committed corpus including the five-domain production set plus known transport/JavaScript failures and must show all of:

- at least 10 percentage points of additional attributable price or image recall over the current production fetcher;
- no more than 2% wrong-product attribution in a manually reviewed sample;
- no robots, redirect-domain, or byte-bound regressions;
- measured per-report runtime and infrastructure cost within a declared launch budget;
- a tested kill switch and no report failure when the Python service is unavailable.

Remove the fallback if it fails any integrity safeguard, adds less than 5 percentage points of recall for two consecutive acceptance runs, or creates an operational dependency that prevents the native report from completing.

## Smallest next implementation task

Add a product-summary-scoped HTML price fallback to the existing TypeScript product-page enrichment path before the WooCommerce API gap becomes user-visible.

Acceptance criteria:

- extract a price only from the requested product's summary/container, never a related-product card;
- require same-page currency evidence and a positive amount;
- preserve identity validation against the expected product before accepting the price;
- retain the WooCommerce adapter as a higher-structure fallback when its payload is valid;
- do not report a blocked Store API as a product-data gap when the page itself already supplied accepted price and image evidence;
- add fixtures for a product page with related-product prices, `del`/`ins` sale pricing, a variable-price range, a missing currency, and a contradictory title;
- verify the linked `myjam.co.uk` scenario increases direct price coverage without changing accepted product identities;
- handle enrichment-budget expansion as a separate task with explicit runtime limits.

## Limitations

This benchmark ran from a local Windows environment, not from the Cloudflare or Trigger production egress network. It is sufficient to reject Scrapling as the solution to this exact report because extracted evidence was identical and response bodies were byte-identical on 27 of 29 pages, but it does not prove that both transports behave identically on blocked sites or from production egress. That broader evidence would be required only before adoption, not before rejection.

## Validation

- Scrapling benchmark completed against all 29 exact rival URLs to generate the committed raw artifact.
- Raw results parse as JSON.
- The benchmark script compiles with Python 3.12.
- No production dependency, runtime, or deployment configuration changed.
