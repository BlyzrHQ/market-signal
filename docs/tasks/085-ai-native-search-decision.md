# Task 085 — AI-native competitor and product search

## Correction

Task 084 optimized its first experiment for an independently inspectable raw
search index. That is useful as a control, but it does not match the product
requirement closely enough. Market Signal needs a retrieval system an AI agent
can ask to:

- find companies that compete with the subject in a stated region;
- verify candidates against explicit market, offering, and business-model
  criteria;
- find direct product-detail pages for semantically comparable products; and
- return structured records with source URLs that the existing crawler can
  verify.

The discovery layer must understand intent and entities, not merely return pages
that rank for manually assembled keyword queries.

## Decision

Make **Exa the first integration and benchmark candidate**.

Use one exact Exa capability for the first benchmark: the **Exa Search API**.

1. The company request uses `type: "auto"`, `category: "company"`, the observed
   two-letter `userLocation`, ten results, and highlights. It discovers company
   candidates from a natural-language market description. Candidate assertions
   cover serving the inferred region, overlapping product families, selling
   directly to the same customer, and excluding publishers, directories, and
   unrelated marketplaces.
2. Product requests use `type: "auto"`, accepted competitor domains as
   `includeDomains`, and ten results without requested page contents. They
   discover product-detail URLs and titles from rich product descriptions; the
   existing first-party crawler obtains product content, prices, and images.

Websets is not part of the first benchmark because its asynchronous candidate
search and criterion evaluation have different latency and cost behavior. It
remains a later experiment if bounded Search API results fail the adoption gate.

Exa produces ranked URLs, titles, and highlights—not Market Signal's final
company schema. After retrieval, one provider-neutral AI normalization call
uses the existing `MARKET_SIGNAL_DISCOVERY_MODEL`, frozen to one exact model
identifier for the complete benchmark. It receives only numbered retrieval
records and the canonical observed business profile. Its constrained JSON
output uses flat criterion fields and arrays of evidence result IDs. Application
code maps those IDs back to the immutable provider URLs. No nested citation
fields are requested from Exa, and Exa grounding is retained separately in the
raw replay artifact.

Use **Parallel as an optional second benchmark challenger**:

- synchronous Entity Search at
  `POST /v1beta/findall/entity-search`, `entity_type: "companies"`, and
  `match_limit: 10` for company discovery; and
- synchronous Search at `POST /v1/search`, `mode: "advanced"`, ten results, and
  excerpts for product retrieval.

FindAll, Task, and Responses are excluded from the first benchmark because their
asynchronous or longer-running behavior does not fit the interactive lane's
latency and cost envelope.

Keep **Brave only as a raw-index control or outage fallback**, not the primary
AI-native experiment. Tavily remains a general agent-search alternative, but it
does not test the company-entity and criteria-verification hypothesis as
directly as Exa or Parallel.

Official sources:

- <https://exa.ai/docs/reference/verticals/company>
- <https://exa.ai/docs/websets/api-guide>
- <https://exa.ai/docs/reference/search-api-guide-for-coding-agents>
- <https://exa.ai/docs/reference/search-best-practices>
- <https://docs.parallel.ai/search/search-quickstart>
- <https://docs.parallel.ai/task-api/task-quickstart>

## Retrieval flow

For each report:

1. Crawl the subject domain first and form an observed business profile from its
   actual products, categories, region, language, and customer proposition.
2. Ask Exa for at most ten company candidates in one request using that full
   profile rather than a short keyword query.
3. Require each candidate result to include its domain, criterion-level
   assertions, and source URLs.
4. Normalize provider results into the existing `SearchSource` shape and pass
   them through `candidatesFromSearchEvidence`,
   `entityCandidatesFromSearchEvidence`, and all existing publisher-path,
   primary-brand, category-overlap, exclusion, and product-detail filters.
5. Run the provider-neutral AI normalizer only on deterministic-filter
   survivors. Rank candidates by product-family overlap, region served,
   direct-customer overlap, independent corroboration, and source quality.
   Record every ranking input, score component, and exclusion reason.
6. Admit only the top bounded set to the unchanged first-party verification and
   crawl budget.
7. Select at most four subject product anchors through the existing
   deterministic `productSearchAnchors` function. Issue at most one Exa request
   per anchor, restricted to the accepted competitor domains, for semantically
   comparable product-detail pages.
8. Crawl those pages directly. Only first-party observed names, prices, images,
   variants, and availability may become product facts.
9. Run the existing deterministic and model-assisted product matcher over the
   observed records. Preserve source, observed time, confidence, and inference
   labels.

Exa or Parallel results are untrusted leads and candidate assertions. Even
source-linked criteria are not called verified until Market Signal fetches and
validates the cited first-party page. Provider output is never the final
authority for competitor status, price, image, availability, or product
identity.

## Structured company result

The provider-neutral normalization call must return a stable schema equivalent
to:

```json
{
  "company_name": "string",
  "domain": "string",
  "serves_region_asserted": true,
  "serves_region_evidence_result_ids": ["company-03"],
  "overlapping_product_families": ["string"],
  "offering_evidence_result_ids": ["company-03", "company-07"],
  "customer_overlap": "string",
  "business_model": "direct_seller | marketplace | publisher | other",
  "business_model_evidence_result_ids": ["company-07"]
}
```

Candidate rejection remains deterministic when the result has no domain, no
regional evidence, no offering overlap, or only directory/marketplace evidence.
An asserted criterion cannot pass the first-party verification gate unless the
cited first-party source is fetched and supports it.

The normalizer may cite only supplied result IDs. Unknown IDs, domains absent
from the retrieval set, schema violations, or uncited positive assertions reject
that candidate. The same normalizer prompt, model, schema, and evidence limits
are used for every provider.

## Structured product result

Normalize every product lead to a stable record equivalent to:

```json
{
  "url": "https://competitor.example/products/item",
  "merchant_domain": "competitor.example",
  "title": "string",
  "brand": "string or null",
  "identifiers": ["string"],
  "variant": "string or null",
  "quantity": "string or null",
  "region": "GB",
  "provider_rank": 1,
  "evidence_urls": ["https://competitor.example/products/item"],
  "retrieved_at": "ISO-8601 timestamp",
  "provider_confidence": "number or null"
}
```

Provider-returned prices, images, availability, descriptions, and identifiers
may help prioritize a URL, but they are not stored as observed product facts.
Those fields become facts only after the existing first-party crawler extracts
them from the normalized product URL.

This product-lead normalization is a deterministic transport mapping, not a
second AI call. Invalid URLs, merchant-domain mismatches, and malformed fields
are rejected before crawling.

## Request and cost budget

The Exa lane has a hard per-report envelope:

- one company request with at most ten results and highlights;
- at most four product requests with at most ten results each;
- no more than five requests total;
- at most two product requests in flight concurrently;
- a 12-second timeout per request and a 30-second wall-clock timeout for the
  complete Exa lane; and
- a USD 0.05 application dispatch ceiling, with the complete lane's versioned
  worst-case reservation checked before its first request.

Pricing reservation `exa-search-2026-07-28-v1` uses the published USD 0.007
Search base price for up to ten results. It reserves USD 0.017 for the company
request—USD 0.007 Search plus a conservative USD 0.010 for ten highlights—and
USD 0.007 for each of four URL/title-only product requests. The complete
five-request lane therefore reserves USD 0.045 before dispatch.

The lane does not start unless the complete USD 0.045 reservation fits within
the USD 0.05 application ceiling. After each response, use `costDollars` only
when it is present, finite, and non-negative; otherwise retain the reserved
amount. Returned cost never releases reservation for additional requests. If
actual cumulative cost exceeds USD 0.05 or any request exceeds its reservation,
stop immediately, record `provider-cost-estimate-exceeded`, and invalidate that
run for adoption evidence. Provider pricing must be rechecked and the versioned
reservation updated before rerunning. This dispatch envelope cannot prevent a
provider from changing its charge after a request, so it is not mislabeled as a
guarantee about external billing.

Model-normalization cost is measured separately and included in total report
cost. Timeouts and provider failures retain completed baseline results. The
production six-company verification and crawl budget remains unchanged.

The provider-neutral normalizer has one call per provider lane, a USD 0.005
versioned reservation, bounded input/output tokens, and no retries. A provider
lane therefore has both the USD 0.05 provider ceiling and a USD 0.055 total
incremental retrieval-plus-normalization ceiling. Missing model price metadata,
a request that cannot fit the reservation, or a returned estimated cost above
the reservation stops the lane and records `normalization-cost-budget-exceeded`.
The exact model identifier, token bounds, and pricing snapshot are frozen in the
benchmark manifest before execution.

All timeouts, retries, and transport-level replays count as new requests against
the five-request limit and must reserve their full cost. Because all five slots
are allocated to the intended calls, the first benchmark performs no automatic
provider retries.

Parallel reservation `parallel-search-2026-07-30-v1` reserves USD 0.005 for one
ten-result Entity Search request and USD 0.005 for each of four ten-result
advanced Search requests, or USD 0.025 total. Its normalizer reserves the same
USD 0.005, making its total incremental ceiling USD 0.030. Parallel uses the
same five-request, 12-second per-request, 30-second lane, concurrency, no-retry,
and six-company verification limits as Exa.

## Canonical request templates

Freeze and record these semantic templates as `ai-native-search-v1`. Adapters
may map only transport parameters such as category, location, domain filter,
result limit, and timeout; they may not add provider-specific keywords,
instructions, or evidence.

Company template:

```text
Find direct companies serving {{region}} that compete with {{subject_domain}}.
The observed subject sells these product families: {{product_families}}.
Observed customer proposition: {{customer_proposition}}.
Return first-party company domains with evidence of regional service and
offering overlap. Exclude publishers, directories, comparison sites, and
directory-only marketplaces.
```

Product template:

```text
Find first-party product-detail pages on {{accepted_competitor_domains}} for
products equivalent to or close substitutes for this observed subject product:
name={{name}}; brand={{brand}}; category={{category}}; variant={{variant}};
quantity={{quantity}}. Prefer exact identity, brand, variant, and quantity
matches, then clearly related substitutes.
```

Empty observed fields remain explicitly empty; no adapter may infer replacements
before retrieval. Store the exact template version, rendered request, provider
parameters, result order, and response timestamp in the secret-free replay
artifact.

## Benchmark

Compare in the same benchmark run:

- the current OpenAI web-search production pipeline, unchanged and scored
  end-to-end as the production baseline;
- Exa Search company-category plus bounded product Search; and
- Parallel Entity Search plus advanced Search if a trial credential is
  available.

Use the existing real ecommerce baselines:

- `myjam.co.uk`: five accepted competitors, 602 primary records, 613 rival
  records, five priced rival records, and one visible product comparison;
- `noororganicfood.com`: 241 primary records and no accepted competitors after
  discovery timeouts.

Each provider receives the same observed business profile serialized from the
same initial subject crawl, the same four deterministic product anchors, the
same ten-company-result and ten-product-result limits, and the same six-company
first-party verification budget. Run all available providers three times per
domain in randomized provider order within the same 24-hour window. Historical
figures are context only; adoption is based on contemporaneous runs.

Exa and Parallel use the canonical `ai-native-search-v1` templates and the same
provider-neutral normalization pass. Transport adapters cannot enrich or rewrite
the semantic request. Exact rendered requests and adapter parameters are stored
for replay and fairness review. The OpenAI production baseline is neither
rewritten onto these templates nor routed through the new normalizer.

Score each challenger independently and also score a deduplicated union of the
OpenAI baseline plus each challenger. The union retains the unchanged
six-candidate verification budget; multi-provider support affects auditable
ranking before the top six are selected. Report per-provider and union metrics
side by side so the Task 084 union adoption gates remain measurable.

Brave, when included as a raw-index control, uses Task 084's deterministic
entity, category, and product query set. It is scored separately and is not
routed through the natural-language challenger template. The artifact labels
this query asymmetry explicitly; Brave cannot become production-primary evidence
from this experiment.

Parallel is scored only when its credential is configured, using the same
profile, anchor, result, timeout, request-count, cost, and verification limits.
Its absence does not make Exa pass; Exa must beat the current OpenAI baseline.

Then add one SaaS and one agency domain before production adoption.

Aggregate the three contemporaneous runs before looking at outcomes:

- yield metrics—verified competitors, catalog products, priced/imaged products,
  and visible pairs—use the median run;
- safety, first-party verification, false-positive, regional truthfulness, and
  SaaS/agency non-regression gates must pass in all three runs;
- latency uses p95 over every request observation and end-to-end run duration;
- cost uses the maximum completed-report cost; and
- any run invalidated by a budget overage, schema failure, or missing replay
  artifact cannot count as a passing run and must be rerun once within the same
  24-hour window or the provider fails that domain.

Measure:

1. verified same-market competitors within the unchanged crawl budget;
2. accepted competitors with at least 25 attributable products;
3. comparable product-detail URLs discovered before crawling;
4. rival products with observed prices and secure images;
5. defensible visible product pairs;
6. investigated-candidate false-positive rate;
7. discovery and end-to-end latency;
8. provider and model cost per completed report; and
9. failures attributable to discovery, access, extraction, or matching.

Attribute failures deterministically:

- **discovery gap**: no provider result contains a first-party product-detail
  URL for a product that a manual blinded audit confirms exists on an accepted
  competitor domain;
- **access gap**: the provider supplied the correct first-party URL but the
  crawler could not fetch the final normalized page;
- **extraction gap**: the page was fetched and visibly contains a price or image
  in the saved response/render, but the extractor did not produce it; and
- **matching gap**: both first-party product records were extracted, but no
  defensible pair was emitted.

The blinded audit labels are fixed before provider identities are revealed.
One failure may be recorded at the earliest responsible stage only, preventing
the same missing field from being charged to multiple providers.

The provider passes only if it improves product-comparison yield, not merely the
number of URLs or candidate names. The Task 084 safety, false-positive, latency,
cost, fallback, and non-ecommerce regression gates remain in force.

## Implementation boundaries

- Add a provider-neutral retrieval interface and secret-free replay fixtures.
- Add one bounded provider-neutral AI normalizer after retrieval; freeze its
  model identifier, prompt version, JSON schema, and evidence limits for a
  benchmark run.
- Configure credentials only through runtime and GitHub secrets. The expected
  credential names are `EXA_API_KEY` and, for the optional challenger,
  `PARALLEL_API_KEY`.
- Do not log prompts containing sensitive customer data or any provider key.
- Preserve the six-company production verification budget until a separate
  performance task approves a change.
- Provider failure must retain completed baseline results and produce a visible
  coverage state.
- Normalize URLs before use; allow HTTP(S) only; reject credentials in URLs,
  private or reserved network targets, unsafe redirects, oversized responses,
  and domains that fail identity validation. Treat provider text and fetched
  content as untrusted data, isolate it from system/developer instructions, and
  never allow it to select tools or alter crawl policy.
- Do not adopt Exa or Parallel in production until the live real-domain
  benchmark passes.
- If the subject crawl cannot establish a two-letter region, do not send a
  provider-default location and exclude that domain from region-controlled
  provider scoring. Exploratory unlocated results must be labeled as such and
  cannot support a regional recall or competitor claim.

## Acceptance criteria

- The architecture decision identifies AI-native semantic/entity retrieval as
  the primary experiment.
- Exa is first, Parallel is the challenger, and Brave is explicitly demoted to
  a control/fallback.
- Company and product retrieval have separate structured contracts.
- The first Exa endpoints, modes, result limits, request limits, timeouts,
  concurrency, and cost ceiling are deterministic.
- First-party crawling remains the source-of-truth boundary.
- The benchmark scores useful comparisons, prices, and images rather than raw
  result volume.
- `git diff --check` passes.
- A strict architecture reviewer returns PASS before merge.

## Review record

- A fresh Codex fallback reviewer was used while the previously observed Fable
  usage limit was still active. It blocked unbounded fan-out, missing result
  contracts, ambiguous endpoints, benchmark unfairness, overstated provider
  verification, missing safety controls, and unclear failure attribution. After
  three focused revision rounds it returned `AI_NATIVE_SEARCH_PASS`.
- After the reset, a verified `claude-fable-5` high-effort review independently
  returned `AI_NATIVE_SEARCH_BLOCK`. It required an unchanged OpenAI production
  baseline, per-provider and six-candidate-union scoring, bounded normalizer
  cost, exact synchronous Parallel endpoints, deterministic pre-ranking filters,
  fixed cross-run aggregation, controlled Brave queries, unknown-region
  handling, and explicit retry accounting.
- The task now includes all those controls. A new verified
  `claude-fable-5` high-effort session re-read Task 085, Task 084, and
  `AGENTS.md` and returned `AI_NATIVE_SEARCH_PASS` with no blocker or major
  finding. It approved only the benchmark architecture; provider adoption still
  requires the live real-domain gates to pass.
