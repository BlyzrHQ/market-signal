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

| Path | Products represented in selected/returned rows | Returned rows | Publishable exactly as returned | Status |
| --- | ---: | ---: | ---: | --- |
| Codex/OpenAI-assisted web-search workflow | 5/5 | 10 selected | 10 | Completed |
| Perplexity anonymous consumer Search | 4/5 | 6 | 0 | Completed; useful leads, invalid facts |
| Kimi consumer UI | — | — | — | Blocked by sign-in |
| Grok consumer UI | — | — | — | Blocked by sign-up |

The current baseline stopped after validating two direct exact-or-close merchant
product pages per source product. Nine selected rows were exact item/SKU matches
and one was a clearly labeled same-construction close substitute. Perplexity
returned six useful-looking rows, but every
row violated at least one requested publication rule: stale price, wrong
currency, forbidden listing page, unverifiable 403 page, or a stale regular
price instead of the current sale price. This is not evidence that Perplexity
cannot find useful leads; it is evidence that its consumer answer cannot be
stored as a verified price fact without a first-party fetch and validator.

Kimi and Grok were not scored because their consumer surfaces required
authentication and no provider API credentials were configured. Treating an
authentication block as zero recall would bias the result.

## Decision

Keep Market Signal's current architecture boundary:

1. A search model or search API proposes candidate URLs.
2. A first-party crawler opens each candidate product page.
3. Deterministic checks validate direct-page type, current visible unit price,
   currency/market, merchant identity, and semantic fit.
4. Only validated facts enter a customer report; rejected rows may remain
   internal discovery evidence with a reason code.

Do not switch production discovery to Perplexity from this screen. Complete a
fair Kimi and Grok API run only after their credentials are configured securely,
using one frozen request per provider, bounded web-search calls, raw usage
capture, and a hard per-provider spend cap. A model ranking should be based on
verified recall, precision, price/currency accuracy, latency, and cost—not the
number of citations in a consumer answer.

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
- The baseline used iterative targeted queries plus first-party validation,
  while Perplexity received one combined prompt. The result compares usable
  workflows, not isolated model intelligence.
- Several baseline merchants allow an interactive browser observation but block
  a separate third-party text fetch. Those rows record the directly observed
  page and price and still require re-crawling before publication. By contrast,
  the rejected Perplexity 403 row was never independently observed with a valid
  price, so its returned fact could not be validated at all.
- Kimi and Grok remain pending authenticated runs. This task is therefore a
  provider screen, not a final provider selection.

## Acceptance

- The evidence JSON parses and preserves the frozen corpus, prompt, provider
  status, raw rows, validation reasons, and known spend.
- Every publishable baseline row is a direct product page with a finite positive
  visible price and an exact or explicitly labeled close semantic match.
- Blocked providers are reported without a fabricated score.
- A focused independent review finds no unsupported provider-ranking claim.
- The PR remains draft while Kimi and Grok are untested; no deployment occurs.

## Independent review

A verified Claude Fable 5 session returned a strict PASS on the provider-screen
conclusion. It independently reproduced sampled provider documentation, exact
baseline prices, and Perplexity rejection reasons. Its three minor labeling
findings—returned versus verified product coverage, the DTLA row's close-match
grade, and browser-observed pages that block third-party text fetches—are
incorporated above and in the evidence file.

## Data-source boundary

All observations are public-source facts collected from merchant product pages
or official provider documentation. Prices are point-in-time observations and
must be re-fetched before customer publication. No API key, cookie, session, or
customer report fact is stored in this task.
