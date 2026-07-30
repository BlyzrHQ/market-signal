# Task 084 — Competitor search provider benchmark

## Problem

Market Signal currently asks OpenAI web search to run independent entity,
category, and product lanes, then admits at most six candidate domains to the
first-party crawl and verification stage. This can find legitimate competitors,
but the resulting mix is unstable and can leave an ecommerce report with
competitors whose public catalogs contain few or no comparable products.

This is not one problem:

1. **Search recall** decides which candidate companies and product-detail URLs
   enter the investigation queue.
2. **Company verification** decides whether a candidate is genuinely in the
   same market.
3. **Catalog crawling and extraction** decides how many products, prices, and
   images are observed from an accepted company.
4. **Product matching** decides which observed products are defensibly
   comparable.

A larger language model cannot compensate for URLs that were never retrieved,
and a crawler cannot compensate for the wrong companies entering the queue.

## Current evidence

- The deployed discovery implementation runs two company lanes and up to four
  product lanes through OpenAI `web_search`, with a 24-second timeout per lane
  and a six-candidate cap.
- Search results remain candidate leads. Every accepted competitor must still
  pass a live first-party crawl and the existing category, independence, region,
  and offering verification gates.
- Task 065 tested ordinary HTTP and Scrapling against the same 29 rival product
  pages. Both fetched 29/29 pages and observed exactly 20 prices and 7 images.
  Scrapling added zero prices and zero images. It is therefore not a search
  recall solution and is not adopted for this experiment.
- No Brave, Exa, Tavily, or Firecrawl credential is currently configured in the
  local environment or GitHub repository. Provider quality has not yet been
  measured with a live API call, so no production provider change is approved.

### Fresh VPS baseline

The Go CLI ran the current production pipeline for `myjam.co.uk` against
`https://signal.blyzr.com` on 2026-07-30. The no-fixture result completed in
about 40 seconds and found five accepted competitors:

- `desiibasket.com`
- `afrigrub.co.uk`
- `oasismarket.co.uk`
- `afrobox.co.uk`
- `halalgrocerystore.co.uk`

The crawl observed 602 primary catalog records and 613 rival catalog records,
but only five rival records exposed a price and the decision document contained
one `product-comparison` block. The entity lane and one product lane timed out
after 24 seconds while completed lanes were retained. This is the baseline to
beat: valid competitor count alone is not a useful result when public price and
defensible comparison yield remain shallow.

A second fresh VPS run used the corrected historical store domain,
`noororganicfood.com`. It completed with 241 primary catalog records but zero
accepted competitors and zero rival records after both entity and category
lanes timed out at 24 seconds. This is a direct search-recall baseline: the
primary crawl worked, while company discovery did not produce a market to
compare.

## Provider research

### Brave Search API — first benchmark candidate

Brave exposes raw web results from an independent index with explicit country
and search-language controls, result pagination, extra snippets, and custom
ranking/filtering through Goggles. Its current Search plan is $5 per 1,000
requests and includes $5 of monthly credits. This is a useful complement to the
current model-mediated search because the application can inspect and score
every returned URL before asking a model to summarize anything.

Official sources:

- <https://api-dashboard.search.brave.com/api-reference/web/search/get>
- <https://brave.com/search/api/>

### Exa Search — second benchmark candidate

Exa supports a `company` category, semantic/deep search modes, a two-letter
`userLocation`, up to 100 results, page contents/highlights, structured output,
and an explicit per-request cost breakdown. These features could improve
company-level recall, but the company category has filter restrictions and its
product-detail URL recall must be measured rather than assumed.

Official source:

- <https://exa.ai/docs/reference/search>

### Firecrawl — extraction fallback candidate, not the first search experiment

Firecrawl combines search with optional result scraping and can crawl an entire
site. Its free plan currently includes 1,000 monthly credits; search consumes
two credits per ten results and crawl/scrape consumes one credit per page.
This may reduce integration work for JavaScript-rendered or transport-blocked
sites, but it combines retrieval and extraction, which makes it harder to
attribute an improvement. It should be tested later on a corpus where ordinary
HTTP actually fails.

Official sources:

- <https://docs.firecrawl.dev/api-reference/endpoint/search>
- <https://docs.firecrawl.dev/features/crawl>
- <https://www.firecrawl.dev/pricing>

### Tavily — retained as an alternative

Tavily offers country boosting and include/exclude-domain filters. Its country
setting boosts rather than strictly filters results, and it does not expose a
company-specific category comparable to Exa. It is not the first paid benchmark
while Brave and Exa cover the two most distinct hypotheses.

Official source:

- <https://docs.tavily.com/documentation/api-reference/endpoint/search>

### Crawlee and Apify — crawl/runtime options, not search indexes

Crawlee provides fast HTTP crawling with Cheerio and browser rendering with
Playwright when JavaScript is required. Apify runs crawlers and browser
automation as hosted Actors with structured datasets. Both can improve runtime
and operational coverage after a URL is known, but neither by itself proves
better competitor-search recall.

Official sources:

- <https://crawlee.dev/js/api/cheerio-crawler>
- <https://crawlee.dev/js/api/3.6/playwright-crawler>
- <https://docs.apify.com/get-started>

## Decision

Build a provider-neutral, offline-replayable benchmark harness before changing
production discovery:

1. keep the current OpenAI search lanes as the baseline;
2. test Brave as a raw-search recall lane;
3. test Exa as a company-semantic recall lane;
4. normalize every provider response into the internal `SearchSource`
   shape—`{ url, title, query }`—then derive candidates through the existing
   `candidatesFromSearchEvidence` and `entityCandidatesFromSearchEvidence`
   filters before constructing a `DiscoveryCandidate`;
5. pass all candidates through the unchanged first-party verification, crawl,
   extraction, and matching gates; and
6. record raw, secret-free provider responses so candidate scoring can be
   replayed without spending more API credits.

Do not replace the baseline with a single provider. If a provider passes, add it
as a bounded complementary lane and deduplicate before the verification budget.

### Deterministic query set

The current OpenAI pipeline remains the end-to-end production baseline. The
Brave-versus-Exa index comparison uses one identical, deterministic query set
per real domain so query authorship cannot be mistaken for index quality:

- entity lane: `"<brand>" alternatives <region>`, `"<brand>" competitors
  <region>`, and `"<brand>" vs <region>`;
- category lane: `<category> companies <region>` and `best <category> <region>`;
- product lane: one query for every existing `productSearchAnchors` result,
  formatted as `"<exact product name>" <region>`; any close variant is generated
  deterministically by normalized word-order rotation, not by a model.

Every issued query, provider, region/language parameter, result rank, and
response timestamp is recorded in the secret-free artifact. Brave and Exa
receive the exact same query strings in the same randomized order. Their raw
results are replayed through the same existing exclusion, publisher-path,
product-detail, primary-brand, and category-overlap filters.

OpenAI's model-mediated action queries are also recorded, but are scored as the
current end-to-end baseline rather than mislabeled as a raw-index comparison.

## Benchmark corpus

The minimum real-data corpus is:

- `myjam.co.uk`: UK ecommerce with a broad cultural-grocery catalog;
- `noororganicfood.com`: ecommerce domain that has previously exposed crawl and
  catalog-coverage failures.

`noororganic.com` is not the same benchmark subject: a fresh VPS request on
2026-07-30 returned a truthful `parked-domain` HTTP 409 and identified a
GoDaddy/Afternic sale page. It must not be used to score competitor-search
quality.

Before production adoption, extend the panel to at least one SaaS company and
one agency so ecommerce-specific ranking does not degrade other supported
business types. Those domains exercise entity and category lanes only because
the current implementation enables product lanes only for ecommerce.

## Candidate budgets

For measurement, each provider's top six filtered candidates is verified
independently using the same first-party verification code and crawl limits.
The deduplicated union is also ranked and measured with a six-candidate budget.
This avoids making provider recall arithmetically unreachable when the baseline
already accepts five of six candidates.

Production adoption does **not** increase `MAX_CANDIDATES` or the six-company
verification-crawl budget. A passing complementary provider contributes leads
to the shared pool; multi-provider mentions and product-detail evidence improve
ranking before the top six are selected. Any future budget increase is a
separate performance and cost task.

## Metrics

Record these separately for every provider and the deduplicated union:

1. attributable search results and unique candidate domains;
2. valid regional same-category competitors after first-party verification;
3. false-positive rate among investigated candidates;
4. accepted competitors with at least 25 attributable catalog products;
5. total attributable rival products;
6. rival products with a public price;
7. rival products with a secure image;
8. defensible visible product pairs;
9. discovery latency, end-to-end latency, request count, and provider cost; and
10. gaps caused by search, access, extraction, or matching.

## Adoption gate

A provider may be added as a production lane only if the real benchmark shows:

- no accepted competitor without current first-party verification;
- an absolute investigated-candidate false-positive rate of at most 25%, and no
  increase of more than five percentage points versus the current OpenAI
  baseline measured in the same run;
- the six-candidate union returns at least one additional verified same-category
  competitor across the two ecommerce domains **or** at least a 50% increase in
  attributable rival catalog products;
- at least a 25% increase in rival products with observed public prices or
  secure images;
- at least two additional defensible visible product pairs across the corpus;
- p95 discovery remains within the current 90-second production gate;
- incremental search-provider cost is recorded and remains at or below USD 0.05
  per completed report for the benchmark query budget;
- the SaaS and agency controls show no reduction in verified competitors and no
  new false-positive competitor versus the current baseline in the same run;
  and
- provider failure leaves completed baseline lanes intact and creates a visible
  coverage gap rather than an empty-market claim.

If neither Brave nor Exa passes, keep the current search provider and address
the measured failure in catalog crawling or extraction instead of weakening
competitor verification.

## Implementation boundaries for the benchmark

- No provider key may enter a query string, log, fixture, task document, or
  committed artifact.
- Store source URL, query, provider, rank, observed time, region, and language
  for each candidate lead.
- Map an observed country to Brave `country` and Exa `userLocation` with ISO
  alpha-2 codes. Map the primary site's observed language to Brave
  `search_lang`. When the region is `Not enough public signal`, omit provider
  location parameters rather than defaulting to the United States; when
  language is unknown, omit `search_lang`.
- Provider snippets are untrusted search evidence, never proof that a company
  is a competitor or that a product/price exists.
- Search-result marketplace and directory pages may seed a company domain but
  cannot become first-party competitor evidence.
- Existing robots, private-network, domain-identity, product-evidence, and price
  integrity rules remain unchanged.
- This task approves a benchmark, not production adoption.

## Validation

- Documentation links were checked against current official provider sources on
  2026-07-30.
- Existing implementation and historical real-data task records were inspected.
- `git diff --check` must pass.
- Strict Fable 5 architecture review must approve the experiment design.
- Live provider execution remains blocked until benchmark credentials are
  configured; that external dependency must not be relabeled as a passing
  quality result.

## Review record

- The first focused Fable 5 search-architecture review returned
  `SEARCH_ARCHITECTURE_BLOCK`. It agreed that Brave and Exa test the two most
  distinct retrieval hypotheses, but blocked unspecified query authorship, a
  normalization seam that could bypass existing filters, unreachable
  candidate-cap arithmetic, ambiguous false-positive wording, and a missing
  SaaS/agency non-regression gate.
- The specification now uses identical deterministic Brave/Exa queries,
  normalizes through `SearchSource` and the existing filters, measures providers
  independently and as a top-six union, keeps the production cap unchanged,
  defines absolute and baseline-relative false-positive gates, adds non-
  ecommerce controls, maps region/language truthfully, and caps incremental
  search cost at USD 0.05 per completed report.
- The verified Fable 5 session re-read the revised task and returned
  `SEARCH_ARCHITECTURE_PASS`. It explicitly approved the benchmark architecture
  only; production adoption remains blocked on live provider results.
