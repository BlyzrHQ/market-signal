# Task 100 — Firecrawl extraction benchmark

## Problem

Market Signal now recovers a selected Babanuj product's public image and price, but we need evidence before deciding whether Firecrawl would improve whole-store product coverage or merely return the same public data through a heavier dependency.

## Scope

- Run Firecrawl against the same real Babanuj storefront and product pages used to validate Task 099.
- Compare Firecrawl with the deployed Market Signal endpoints on product URL discovery, product identity, image URL, listed price, source fidelity, latency, and visible gaps.
- Separate the open-source self-hosted result from claims made for Firecrawl's hosted Fire-engine service.
- Respect published robots policy and use only public pages.
- Make no production integration in this task.

## Acceptance

- Record the exact Firecrawl revision and runtime configuration used.
- Exercise at least the Babanuj homepage, one collection/catalog surface, and the known `zaitoune-maamoul-date-250g` product page.
- Compare observed product images and prices with Market Signal using the same source URLs.
- Record failures and infrastructure requirements honestly.
- Obtain a strict Fable 5 decision on whether the measured improvement justifies an integration task.
- Publish the benchmark as a focused PR; do not deploy because this task changes no product behavior.

## Status

Benchmark complete; strict Fable decision passed after evidence-hygiene fixes.

## Reproducible setup

- Firecrawl source revision: `9554ad079840b0d405d5b1e5b1c57e577b4249cb`.
- Runtime: the repository's Docker Compose stack with the API on port 3002, database authentication disabled, two workers, two concurrent crawl requests, and no proxy, search, model, or hosted API credentials.
- Containers required by that stack: Firecrawl API, Playwright service, Redis, RabbitMQ, PostgreSQL, and FoundationDB.
- Harness: [`scripts/benchmark-firecrawl.mjs`](../../scripts/benchmark-firecrawl.mjs).
- Raw observations: [`100-firecrawl-benchmark-evidence.json`](./100-firecrawl-benchmark-evidence.json).

The harness used a declared benchmark user agent, checked Babanuj's public robots file, read only public pages, and performed no anti-bot bypass. Firecrawl's own self-hosting guide says the open-source self-hosted stack does not include Fire-engine, including its advanced IP-block and robot-detection handling. This result therefore says nothing about the paid hosted Fire-engine service.

## Results

### Discovery and catalog surfaces

| Probe | Existing direct path | Firecrawl self-hosted | Difference |
| --- | ---: | ---: | --- |
| Product URLs discovered | 80 in 78 ms from sitemap | 80 in 493 ms from `/v2/map` | The URL sets were identical |
| Homepage product links | 24 in 94 ms | 24 in 813 ms | No coverage gain |
| Cookies collection product links | 10 in 81 ms | 10 in 747 ms | No coverage gain |

Firecrawl's map and the public sitemap each returned 105 total site links. The harness compared the 80 product URLs as sets and recorded empty `onlyInFirecrawlProducts` and `onlyInSitemapProducts` arrays: neither product discovery surface contained a URL omitted by the other.

### Ten product pages

| Metric | Firecrawl self-hosted | Deployed Market Signal |
| --- | ---: | ---: |
| Pages fetched | 10/10 | 10 requested |
| Pages returned as products | 10/10 raw pages | 6/10 accepted products |
| Returned products with an image | 10/10 | 6/6 accepted |
| Returned products with a price | 10/10 | 6/6 accepted |
| Price agreement on accepted identities | 6/6 | 6/6 |
| Median per-page scrape | 1,777 ms | 430 ms for the complete 10-page batch |

The elapsed times are directional, not a provider SLA: Firecrawl ran locally with two-way concurrency while Market Signal ran on the deployed VPS. They are sufficient to show that Firecrawl was not a latency improvement in this test.

The four apparent Firecrawl additions are not missing scrape results. They are stale sitemap identities:

- `kol-and-shkor-with-honey-500g` now renders “Baklava with Honey Special Edition”.
- `mixed-nawashif-500g` now renders “Sesame Cookies (Barazek)”.
- `maamoul-with-walnut-500g` now renders a 600g product.
- `mabrouma-400g` now renders a 500g product.

Firecrawl returned the live HTML, image, and visible price for those URLs but did not decide whether the live product could safely replace the stale sitemap record. Market Signal fetched the same live pages and rejected the contradictory identities instead of attaching a different product's price to the old name. On all six non-contradictory pages, both paths found an image and exactly the same USD price.

As a concrete extraction hazard, the first unscoped currency value in Firecrawl's HTML was the store's `$75` free-shipping threshold, not the product price. A product-scoped selector recovered the correct `$10.80`. Firecrawl supplies transport and normalized content; Market Signal must still own product identity and price-evidence logic.

## Codex decision before review

**Reject a self-hosted Firecrawl integration for the Babanuj image/price problem.** It returned the same valid product evidence, the same product discovery set, and no safely usable additional product. Adopting it would add six services and another extraction boundary without improving this report.

The measured gap supports a different follow-up: catalog-drift reconciliation. When a selected public URL still resolves but its live identity contradicts the sitemap record, Market Signal should preserve the rejection, record the observed replacement identity, and decide whether that live product can become a new canonical catalog entry. That can be implemented with the existing fetch path; Firecrawl is not required.

The rerun also recorded Firecrawl's final `metadata.url` for every pair, falling back to `metadata.sourceURL` only when a final URL is absent. All four stale identities resolved on their original URL without a redirect, so the follow-up must distinguish in-place product replacement from redirect-based succession and should refresh stale discovery records rather than repeatedly selecting them.

A future Firecrawl test would be justified only on a benchmark set where the existing permitted static and rendered fallbacks cannot obtain a page, and it must evaluate either the hosted service separately or a self-hosted proxy/render configuration. Hosted claims must not be inferred from this open-source run.

## Fable decision

Verified `claude-fable-5` reviewed the harness, raw observations, production identity gate, and operational boundary. Its first strict decision was PASS — REJECT, conditioned on fixing two evidence-hygiene findings before merge: compare discovery URL sets instead of only equal counts, and make the harness emit the Firecrawl revision rather than adding it manually to the artifact. The rerun implemented both, added final-URL/redirect evidence, and replaced the blanket robots check with path-level rule evaluation including wildcard and end-anchor rules. Its second review retained PASS and requested that final-URL evidence use Firecrawl's `metadata.url`; that final instrumentation correction was applied before the last rerun.
