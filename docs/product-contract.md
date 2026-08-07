# Market Signal — Product Contract

## Working promise

Enter a company domain and receive an evidence-backed competitive intelligence report that explains who the company competes with, how the market is positioned, how products and pricing compare, and what competitors are publicly advertising and publishing.

## Initial audience

- Startups
- Agencies
- Ecommerce brands

## Initial experience

1. The user enters one domain.
2. Market Signal infers the company category, region, language, and likely competitors.
3. The user receives a report containing:
   - competitor discovery and rationale;
   - market-positioning scorecards and narrative;
   - product and pricing comparison;
   - observed public ad creatives and social activity;
   - recommendations and tracked changes;
   - exportable results and configurable alerts.
4. The first release minimizes account friction; accounts, teams, and billing follow demonstrated demand.

## Product decisions captured

- The product is global by intent; regional context should be inferred from public signals and remain overridable.
- Monitoring cadence is customer-configurable rather than fixed.
- The initial data boundary is public information about the submitted domain and competitors.
- The first monitoring channels are Meta, Google, and TikTok.
- Competitors are selected automatically in v1; there is no manual approval step.
- The first report may show estimated spend ranges, but never exact spend, and every estimate carries confidence and methodology.
- Hosted report generation requires an active paid workspace. Public marketing
  pages may explain or preview the product, but do not grant unmetered live
  reports.
- English is the launch language; regional and language inference is visible and overridable.
- Paid data providers are deferred, but remain an explicit budget-dependent option.
- The hosted business model is paid-only subscription tiers; there is no
  permanently free hosted plan. A free self-hosted/open-source edition uses the
  operator's own infrastructure and provider credentials.
- Hosted allowances are expressed as report runs, monitored domains, refresh
  cadence, seats, and capabilities. Internal provider cost units are an
  operational margin control, not the customer's invoice unit.
- The paid release needs a dashboard/report surface, exports, recommendations,
  alerts, account/workspace access, and clear usage visibility.

## Evidence and trust requirements

- Every material claim should link to its source and capture an observed date.
- “Ad spend” must not be presented as exact when it is not publicly observable; estimates need a confidence label and methodology.
- Scraping must respect applicable site terms, robots directives, rate limits, and platform access rules. Where a platform provides an official public library or API, prefer it.
- The report must distinguish observed facts, inferred comparisons, estimates, and recommendations.

### Shared evidence schema

Every material report item should carry:

- `claimType`: `observed`, `inferred`, `estimated`, or `recommended`;
- `sourceUrl`: the public source supporting the item;
- `observedAt`: when the source was captured or checked;
- `confidence`: `high`, `medium`, or `low`;
- `methodology`: required for estimates and useful for inferences;
- `region` and `language`: the context in which the item applies.

### Initial source-adapter contract

Meta, Google, and TikTok adapters should return normalized evidence records rather than provider-specific UI data. Each adapter must declare its access method, coverage limits, request/rate-limit posture, and whether a field is directly observed or estimated. Official public libraries or APIs are preferred; permitted scraping is a fallback only when it respects applicable terms, robots directives, and rate limits.

## MVP task sequence

1. Finalize the evidence policy, launch geography behavior, source adapters, and no-account acquisition flow.
2. Build domain intake and a credible first report using a small, inspectable evidence set.
3. Add competitor discovery and transparent market-positioning scorecards.
4. Add product/pricing comparison with source evidence and confidence labels.
5. Add public ads and social monitoring with configurable refresh cadence.
6. Add recommendations, alerts, exports, and free-trial conversion.
7. Add authentication, workspaces, billing, and team features after demand validation.

## Open decisions before data implementation

- Monthly budget available for paid data providers, if public sources are insufficient.
