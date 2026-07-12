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
- The business model is a free trial followed by subscription tiers.
- The first release needs a dashboard/report surface, exports, recommendations, and alerts, while keeping sign-up friction low.

## Evidence and trust requirements

- Every material claim should link to its source and capture an observed date.
- “Ad spend” must not be presented as exact when it is not publicly observable; estimates need a confidence label and methodology.
- Scraping must respect applicable site terms, robots directives, rate limits, and platform access rules. Where a platform provides an official public library or API, prefer it.
- The report must distinguish observed facts, inferred comparisons, estimates, and recommendations.

## MVP task sequence

1. Finalize the evidence policy, launch geography behavior, source adapters, and no-account acquisition flow.
2. Build domain intake and a credible first report using a small, inspectable evidence set.
3. Add competitor discovery and transparent market-positioning scorecards.
4. Add product/pricing comparison with source evidence and confidence labels.
5. Add public ads and social monitoring with configurable refresh cadence.
6. Add recommendations, alerts, exports, and free-trial conversion.
7. Add authentication, workspaces, billing, and team features after demand validation.

## Open decisions before data implementation

- First social and ad channels.
- Whether the MVP reports observed public ads only or also includes estimated spend.
- The exact competitor approval/editing flow after automatic discovery.
- The first launch language(s) and regional fallback behavior.
- The lead-capture rule for a no-account report.
- Monthly budget available for paid data providers, if public sources are insufficient.
