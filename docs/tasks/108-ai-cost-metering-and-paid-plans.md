# Task 108 — AI cost metering and paid plans

## Outcome

Define a cost ledger that measures every variable provider expense behind a
Market Signal report, then use measured production cost to set paid hosted
plans without weakening the free self-hosted/open-source edition.

This task is a product and architecture decision. It does not enable checkout,
enforce quotas, change the repository license, or publish final allowances.

## Current-state finding

The application cannot safely price report allowances yet. The
`report_evaluations` table has `pricing_version`, `cost_microusd`,
`input_tokens`, and `output_tokens`, but most report-pipeline calls do not save
provider usage. A report can currently invoke:

- two competitor entity/category web-search lanes and as many as four product
  search lanes on `gpt-5.4-mini`;
- `text-embedding-3-small` over synchronized product catalogs;
- bounded product-judge batches on `gpt-5.4-mini`, with one application-level
  retry when coverage is defective;
- as many as 20 action-planning calls on `gpt-5.4-mini`;
- a market brief on the configured report model, currently `gpt-5.6-luna` in
  production; and
- an advertising search phase even though advertising is not currently shown
  as a customer feature.

The cost is driven by catalog size, search/tool calls, accepted product pairs,
retries, and provider fallbacks—not merely by the number of submitted domains.

## Decision: Signal Cost Units

Use **Signal Cost Units (SCU)** as an internal normalization layer:

```text
1 SCU = USD 0.01 of measured variable provider cost

raw_report_cost_microusd =
  sum(model token cost + tool-call cost + retrieval/provider cost)

raw_report_scu = ceil(raw_report_cost_microusd / 10,000)
```

Accumulate micro-USD across the complete logical report before rounding. Do
not round every provider call to one SCU.

SCU includes AI inference, embeddings, hosted web search, paid crawl/recovery,
proxy/browser, and licensed data-provider usage. Each cost retains a category,
so AI cost and retrieval cost remain separately auditable. Fixed VPS, database,
support, and payroll costs are not SCU; they remain part of the broader gross
margin model.

SCU is not a currency, token resale, or the customer's invoice unit. Customers
buy an understandable outcome: report runs, primary products assessed,
monitored domains, refreshes, seats, exports, and workspace capabilities. SCU
is visible only in internal operations and, optionally, a detailed workspace
usage page.

### Product assessment unit

Product count is a separate customer-facing usage dimension because retrieval,
embedding, and judgment cost grows with catalog size. One **product assessed**
means one primary-company product received a usable comparison assessment in a
saved report. A `no_match` verdict still counts because the product was
analyzed; merely discovering or crawling a catalog record does not.

Count a primary product at most once per report. Multiple rival candidates,
judge calls, retries, embeddings, and fallbacks do not multiply customer usage.
They remain internal SCU drivers. “Products assessed” does not promise that a
close rival exists or that a comparison will be accepted for every product.
The pricing page calls this **products analyzed**, defined as products from the
customer's catalog that Market Signal searches for and evaluates against
potential rivals. Never call the allowance “product matches.”

## Cost ledger

Add an append-only `provider_usage_events` ledger in a follow-up task. Each
event must contain:

- `id`, `workspace_id`, `report_run_id`, `logical_operation_id`, `attempt_id`;
- provider, model, operation/stage, processing tier, region, and status;
- input, cached-input, and output tokens;
- tool name and tool-call count;
- primary products selected and successfully assessed, catalog records
  embedded, candidate pairs retrieved, and candidate pairs judged;
- provider quantity and unit for non-token services;
- immutable pricing-version identifier and currency;
- raw provider cost in micro-USD;
- customer-eligible cost in micro-USD;
- retry/fallback/cache indicators; and
- provider request ID, start time, finish time, and latency where available.

The pricing catalog is versioned by effective date. A saved event never changes
when a provider later changes its price.

### Charging rules

- Provider usage is recorded even when a call fails, so real COGS is known.
- A customer consumes one report run only when the requested logical report
  reaches a usable saved terminal state.
- Internal retries, parse repair, provider failure, and automatic fallback are
  company COGS and never consume another customer report allowance.
- A customer-requested refresh or explicit rerun is a new report run.
- A failed report consumes no customer allowance. Abuse controls may still
  limit repeated failed submissions.
- Hidden or unreleased work is not customer-eligible. The current hidden ads
  phase should be disabled before paid launch unless it materially feeds a
  visible report feature.
- Every stage has a hard cost/call budget. When it is exhausted, the report
  must preserve completed evidence and show a coverage state rather than spend
  without a bound.

## Pricing reference and current rates

Photo AI is a useful packaging reference because it combines credits with
meaningful capability limits such as model count, quality, concurrency, and
commercial use. Market Signal should copy that principle, not Photo AI's credit
ratios. Business customers understand analyses, monitored markets, refresh
frequency, seats, and client workspaces better than model tokens.

Pricing inputs checked on 2026-08-06:

- Photo AI monthly tiers: USD 19, 49, 99, and 199, with credits plus capability
  limits: <https://photoai.com/pricing>.
- `gpt-5.4-mini`: USD 0.75/M input, 0.075/M cached input, and 4.50/M output.
- `gpt-5.6-luna`: USD 1.00/M input, 0.10/M cached input, and 6.00/M output.
- `text-embedding-3-small`: USD 0.02/M input.
- OpenAI web search: USD 10/1,000 calls plus search-content tokens billed at
  model rates: <https://developers.openai.com/api/docs/pricing>.

Provider prices are temporal inputs, not constants to scatter through code.
When no current pricing record matches the provider, model, processing tier,
region, and effective date, preserve the raw usage as `unpriced`, alert an
operator, and exclude it from customer-eligible units. Never silently price it
with an old or guessed rate.

## Paid hosted plan hypotheses

There is no permanently free hosted plan. The open-source self-hosted edition
is the free path. These hosted allowances are private-beta hypotheses, not yet
public guarantees:

| Edition | Monthly price | Customer-facing allowance | Internal variable-COGS ceiling |
| --- | ---: | --- | ---: |
| Self-hosted | Free | Unlimited by Market Signal; bring infrastructure and provider keys | USD 0 hosted spend |
| Starter | USD 8 | 5 completed runs; up to 20 products analyzed/report (100/month); 1 monitored domain; manual refreshes; 1 seat | USD 1.20 / 120 SCU |
| Solo | USD 29 | 10 runs; up to 60 products analyzed/report (600/month); 3 monitored domains; monthly scheduling; 1 seat | USD 4.35 / 435 SCU |
| Growth | USD 79 | 40 runs; up to 60 products analyzed/report (2,400/month); 10 monitored domains; weekly scheduling; 3 seats; exports and sharing | USD 11.85 / 1,185 SCU |
| Agency | USD 199 | 120 runs; up to 60 products analyzed/report (7,200/month); 30 monitored domains; flexible scheduling; 10 seats; client workspaces and branded exports | USD 29.85 / 2,985 SCU |

Every scheduled refresh consumes one included report run. Scheduling frequency
is a capability, not a promise of unmetered refreshes. Top-ups are prepaid and
explicit; there are no surprise overage invoices. Annual billing is two months
free after monthly retention and cost are understood.

Starter is intentionally an easy paid entry point, not a free trial. Its five
runs are consumed only by usable completed reports. It remains separate from
Solo so the upgrade path does not jump directly from USD 8 to USD 79. Because
payment fees and support are proportionally significant at this price, Starter
is self-service, has standard processing priority, and has no scheduled
monitoring, API, teams, or premium connectors. Enforce account-cycling,
concurrency, crawl-page, competitor, retry, and AI-spend controls. Extra runs
require an upgrade rather than cheap unlimited overages. Starter must be
removed, repriced, or reduced if measured p95 cost exceeds USD 0.24 per
completed run or USD 1.20 for the monthly allowance.

The product allowances are also beta hypotheses. Starter deliberately analyzes
the top 20 selected primary products per report; higher plans match the current
bounded capability of 60. Products beyond the per-report cap remain visible as
catalog coverage, but are not silently marked as compared. A future deep-catalog
add-on must be priced from measured incremental embedding and judgment cost.
Before a run starts, show the estimated catalog count, the plan's per-report
analysis cap, and how products will be selected. Prefer explicit customer
selection; otherwise use documented observable catalog-priority signals and
show which products were excluded. Failed reports consume neither runs nor
product allowance. An explicit rerun consumes a new run and counts the products
successfully assessed in that saved report.

The clearest Starter headline is: **5 reports per month, with up to 20 of your
products analyzed in each report.** Keep the 100-product monthly maximum in the
detailed limits rather than making it a third headline quota.

The 15% ceilings target at least 85% gross margin before fixed infrastructure,
support, payment fees, refunds, and taxes. They are safety budgets, not evidence
that the proposed report allowances are profitable.

Agency is the sharpest utilization risk: its USD 29.85 ceiling permits roughly
USD 0.25 per fully used report and USD 0.004 per fully used product allowance.
Its limits cannot become permanent until real p95 telemetry supports both the
cost ceiling and report-quality gate.

## Quota release gate

Do not publish fixed report allowances until at least 50 representative,
non-fixture reports have complete usage ledgers. Include ecommerce, SaaS,
agency, small catalog, large catalog, successful, limited, recovered, and failed
runs. Prefer 100 reports before general availability.

The launch dataset must report:

- raw and customer-eligible cost by report and stage;
- p50, p90, p95, and maximum cost and latency;
- search/tool calls, model tokens, primary products selected and successfully
  assessed, products embedded, candidate pairs retrieved and judged, actions
  drafted, retries, failures, and cache savings;
- cost per accepted useful product match;
- report-quality evaluator score alongside cost; and
- simulated monthly cost for the intended customer mixes in each plan.

For each plan:

```text
simulated p95 monthly variable cost <= monthly price * 0.15
```

Quality is a second gate: cost reduction cannot pass if it materially lowers
competitor yield, accepted useful product matches, evidence integrity, or the
saved report's agent evaluation.

## Open-source and paid boundary

Recommended direction, subject to legal review:

- license the self-hostable core under **AGPL-3.0**;
- include the CLI, crawling/orchestration, matching, report generation, usage
  metering interfaces, and a functional self-hosted UI;
- require self-hosters to bring their own model/search/provider keys, database,
  workers, storage, monitoring, email, and domain;
- sell the managed service: operated workers, storage, upgrades, scheduling,
  observability, billing, teams, support, and properly licensed premium
  connectors; and
- keep proprietary cloud-only services outside the AGPL repository only if the
  company intentionally chooses an open-core model.

AGPL is OSI-approved and requires covered network software to offer source to
remote users, but it does not prohibit another party from operating a competing
service. Do not call a non-compete or source-available license “open source.”
Obtain counsel before changing the repository license or accepting external
contributions.

References:

- <https://opensource.org/license/agpl-3-0>
- <https://www.gnu.org/licenses/gpl-faq.en.html>
- <https://www.gnu.org/licenses/gpl-howto.en.html>

## Follow-up implementation sequence

1. Add the versioned pricing catalog, append-only usage ledger, and cost
   calculator with deterministic tests.
2. Instrument every AI, embedding, web-search, crawl/recovery, and external
   provider adapter; reconcile sampled records against provider dashboards.
3. Add per-stage and per-report budget controls, logical-operation idempotency,
   and failed/retry charging rules.
4. Run and evaluate the 50–100 report cost corpus; freeze beta quotas only after
   the p95 margin and quality gates pass.
5. Add authentication, workspaces, entitlements, prepaid top-ups, payment
   webhooks, invoices, and an operator reconciliation view.
6. Publish the pricing page and license only after product, finance, and legal
   approval.

Each item is a separate focused task and PR.

## Review state

- Fable 5 review was attempted with the verified `claude-fable-5` model on
  2026-08-06. Claude Code returned `Failed to authenticate: OAuth session
  expired and could not be refreshed`; no Fable judgment was claimed.
- A Codex subagent fallback review passed the direction but blocked final quota
  publication until representative production telemetry exists. It specifically
  required all-provider cost coverage, logical-operation charging, hidden-work
  exclusion, per-report budgets, and p95 cost/quality gates. Those requirements
  are incorporated above.
- On 2026-08-07, Fable authentication remained expired during review of the
  USD 8 Starter revision. A clearly labelled Codex fallback reviewer passed
  adding Starter before Solo, with a strict USD 0.24 p95 per-run ceiling,
  self-service feature boundaries, and abuse controls. It blocked presenting
  five runs as a permanent guarantee before metering verifies that ceiling.
- Fable authentication was attempted again for the product-count meter and
  returned the same expired-OAuth error. The proposal therefore remains behind
  the same strict Fable merge gate.
- A labelled Codex fallback reviewer passed the product meter for beta only. It
  required “products analyzed” wording, pre-run count visibility, no guarantee
  of a successful match, single-count semantics, explicit excluded-product
  coverage, and an Agency utilization warning. Those conditions are included.
- This PR must remain unmerged until the required Fable 5 review can run and
  returns a strict PASS.

## Acceptance criteria

- The internal unit, cost formula, ledger schema, retries/failures policy, and
  customer-facing unit are unambiguous.
- AI and non-AI variable provider costs are separately auditable and roll up to
  one normalized report cost.
- Paid-only hosted hypotheses have explicit COGS ceilings and are labelled as
  unvalidated until the telemetry gate passes.
- The self-hosted and managed-service boundary is explicit without implying
  that AGPL prevents commercial hosting.
- Implementation is decomposed into focused follow-up tasks rather than mixing
  billing, licensing, and instrumentation into one release.
