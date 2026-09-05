# Task 152: screen search-model providers for comparison discovery

## Objective

Compare Perplexity, Kimi, Grok, and the current Codex/OpenAI-assisted search
workflow on one frozen five-product Wearform corpus. Measure whether each path
returns direct first-party merchant product pages with a current finite positive
USD unit price. Keep discovery leads separate from facts that pass Market
Signal's publication boundary.

## Scope

- Use the same source products, constraints, and JSON response shape for every
  provider.
- Preserve the raw provider rows and independently validate URL type, merchant,
  title, price, currency, and semantic fit.
- Record authentication blocks as `blocked_by_authentication`; do not score them
  as empty or failed results.
- Record actual paid API spend. This screen must not mutate production reports,
  deploy code, or launch a customer evaluation.
- Treat the Codex/OpenAI baseline as an operational search-and-validation
  workflow, not a pure one-shot model comparison.

The frozen corpus, prompt, output rows, and validation decisions are in
`152-search-model-provider-benchmark-evidence.json`.

## Result

| Path | Products represented | Returned/selected rows | Literal prompt passes | Active validated offers | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| Codex/OpenAI-assisted web-search workflow | 5/5 | 10 selected | 10 | 10 | Completed |
| Perplexity anonymous consumer Search | 4/5 | 6 | 0 | 0 | Completed; useful leads, invalid facts |
| Kimi consumer UI, K2.6 Instant fallback | 5/5 | 16 | 11 | 10 | Completed; noisy and operationally unstable |
| Grok consumer UI, Fast | 5/5 | 14 | 11 | 9 | Completed; cleanest one-shot candidate set |

The current baseline stopped after validating two direct exact-or-close merchant
product pages per source product. Nine selected rows were exact item/SKU matches
and one was a clearly labeled same-construction close substitute. Perplexity
returned six useful-looking rows, but every
row violated at least one requested publication rule: stale price, wrong
currency, forbidden listing page, unverifiable 403 page, or a stale regular
price instead of the current sale price. This is not evidence that Perplexity
cannot find useful leads; it is evidence that its consumer answer cannot be
stored as a verified price fact without a first-party fetch and validator.

After the user authenticated both consumer surfaces, Kimi and Grok received the
same frozen prompt. Kimi returned 16 rows. Eleven rows satisfied the literal
direct-page, visible-USD-price, and exact-or-close-match rules; ten were active
purchasable offers and one was sold out. Its five rejected rows were one
category page carrying another product's price, two public product pages whose
claimed prices were not visible, and two HTTP 403 pages that could not be
verified. The first Kimi attempt and the retry both encountered repeated search
timeouts; the retry completed only after the UI automatically switched from
K2.6 Thinking to K2.6 Instant and reported that its tool-call budget was
exhausted.

Grok returned 14 rows. Eleven satisfied the literal rules; nine were active
purchasable offers and two showed the returned price but were unavailable or
backordered. Its three rejected rows were one stale price and two unverifiable
HTTP 403 pages. Grok's Fast consumer run produced the highest one-shot literal candidate
precision (11/14, 78.6%). Kimi produced one more active validated offer
(10 versus 9), but at lower active precision (10/16, 62.5%) and with materially
worse run stability. Neither consumer surface disclosed an API model identifier,
token usage, or API cost, so this does not establish an API-provider winner.

## Decision

Keep Market Signal's current architecture boundary:

1. A search model or search API proposes candidate URLs.
2. A first-party crawler opens each candidate product page.
3. Deterministic checks validate direct-page type, current visible unit price,
   currency/market, merchant identity, and semantic fit.
4. Only validated facts enter a customer report; rejected rows may remain
   internal discovery evidence with a reason code.

Do not switch production discovery to a consumer answer from this screen.
Grok Fast was the cleanest one-shot candidate generator, while Kimi K2.6
Instant produced the largest active set but was less precise and less reliable.
The current iterative workflow remains the safest publication path because all
ten rows it selected passed first-party validation. A fair API decision still
requires one bounded request per provider with exact model IDs, raw usage,
latency, and cost capture. Rank API paths on verified recall, precision,
price/currency accuracy, latency, and cost—not citation count.

## Provider capability and pricing references

- Perplexity documents Search API pricing and Sonar request/token pricing at
  <https://docs.perplexity.ai/docs/getting-started/pricing>.
- Kimi documents its OpenAI-compatible API and current model guidance at
  <https://platform.kimi.ai/docs/overview>, built-in web search at
  <https://platform.kimi.ai/docs/guide/use-web-search>, and tool-call pricing at
  <https://platform.kimi.ai/docs/pricing/tools>.
- xAI documents server-side web search at
  <https://docs.x.ai/developers/tools/web-search> and model/tool pricing at
  <https://docs.x.ai/developers/pricing>.
- OpenAI documents GPT-5.4 mini and web-search support at
  <https://developers.openai.com/api/docs/models/gpt-5.4-mini> and API/tool
  pricing at <https://platform.openai.com/pricing>.

## Cost and limitations

- Actual paid API spend for this screen: USD 0.00.
- The Perplexity run used its anonymous consumer Search surface; the exact model
  was not disclosed, so it must not be relabeled as Sonar.
- The authenticated Grok run used the consumer label `Fast`; the exact xAI API
  model was not disclosed, so it must not be relabeled as a numbered Grok API
  model.
- Kimi visibly attempted `K2.6 Thinking`, then automatically fell back to
  `K2.6 Instant` because of demand. The run also encountered repeated search
  timeouts and exhausted its tool-call budget. These are consumer-UI
  observations, not API reliability or pricing measurements.
- The baseline used iterative targeted queries plus first-party validation,
  while all three external providers received one combined prompt. The result
  compares usable workflows, not isolated model intelligence or equal search
  budgets.
- Several baseline merchants allow an interactive browser observation but block
  a separate third-party text fetch. Those rows record the directly observed
  page and price and still require re-crawling before publication. By contrast,
  the rejected Perplexity 403 row was never independently observed with a valid
  price, so its returned fact could not be validated at all.
- The frozen prompt did not require current stock. This task therefore records
  both literal prompt passes and the stricter active-offer count instead of
  silently treating unavailable prices as purchasable comparisons.
- Consumer UIs do not expose controlled model IDs, tool budgets, token usage, or
  equivalent pricing. This remains a provider screen, not a final production
  selection.

## Acceptance

- The evidence JSON parses and preserves the frozen corpus, prompt, provider
  status, raw rows, validation reasons, and known spend.
- Every publishable baseline row is a direct product page with a finite positive
  visible price and an exact or explicitly labeled close semantic match.
- Every authenticated provider is scored from independently opened merchant
  pages; search snippets alone are never accepted as price evidence.
- A focused independent review finds no unsupported provider-ranking claim.
- The PR remains draft until an API-controlled follow-up is authorized; no
  deployment occurs.

## Independent review

A verified Claude Fable 5 session returned a strict PASS on the initial
provider-screen conclusion and a second strict PASS on the authenticated
Kimi/Grok extension. It independently recounted every validation state and
aggregate, checked the JSON structure, and found no blocker or major issue. Its
minor documentation findings—preserving returned titles/reasons and Grok's own
semantic labels, plus consistently qualifying one-shot precision—are
incorporated above and in the evidence file.

## Data-source boundary

All observations are public-source facts collected from merchant product pages
or official provider documentation. Prices are point-in-time observations and
must be re-fetched before customer publication. No API key, cookie, session, or
customer report fact is stored in this task.
