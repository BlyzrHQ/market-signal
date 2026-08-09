# Task 064: Privacy-first product analytics

## Outcome

Add product analytics that shows where visitors enter, whether they start and complete a report, which report areas they use, and whether they export or share. The integration must remain disabled when credentials are absent and must never affect report execution.

## Decision proposal

Use PostHog Cloud EU behind a typed, provider-neutral client adapter.

Why PostHog is the proposed fit:

- Market Signal needs product funnels and retention, not only aggregate page traffic.
- The same platform can later support experiments, feature flags, surveys, and privacy-reviewed session replay.
- The current free tier is large enough for the launch stage and supports product-specific billing caps.
- The official Next.js integration supports the App Router and explicit event capture.
- Cookieless anonymous tracking can avoid browser storage when configured with `cookieless_mode: "always"` and `person_profiles: "never"`.

Alternatives considered:

- Umami: strong self-hosted privacy option, but less complete for experiments and product iteration.
- Plausible: excellent aggregate web analytics, but too shallow for report workflow and feature usage analysis.
- OpenPanel: promising product analytics and AI access, but a smaller and newer ecosystem.
- Matomo: mature and self-hostable, but heavier to operate and behavioral tooling is less economical for this stage.

## Privacy and reliability contract

- Analytics is inert unless `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` is configured.
- Default to PostHog's EU ingestion host.
- Use cookieless anonymous tracking and never create person profiles or call `identify`.
- Disable autocapture. Only explicit, typed events are allowed.
- Never send domains, report IDs, URLs, query strings, product names, evidence, free text, emails, or account identifiers.
- Strip URL/query/referrer properties in a final `before_send` guard.
- Respect browser Do Not Track.
- Session replay is disabled by default and controlled by a separate environment flag.
- If replay is later enabled, mask all inputs and all page text, strip query strings, and require a privacy/consent review before production activation.
- Analytics failures must be swallowed and must never block navigation, report creation, report rendering, exporting, or sharing.

## Minimal event taxonomy

| Event | Safe properties |
| --- | --- |
| `landing_viewed` | `locale` |
| `report_requested` | `locale`, `input_kind` (`domain` or `url`) |
| `report_request_failed` | `locale`, `failure_stage` |
| `report_viewed` | `report_status`, `plan_key`, `has_competitors`, `has_product_matches` |
| `report_section_viewed` | `section`, `layout`, `report_status`, `plan_key` |
| `report_exported` | `format`, `section`, `plan_key` |
| `report_shared` | `share_method`, `section`, `plan_key` |

All event names and enum-like values are compile-time allowlisted. Counts are not included in the initial release because sparse combinations can fingerprint reports; they can be added later after a k-anonymity/privacy review.

## Instrumentation scope

- Initialize the browser SDK once from the root layout through a client component.
- Capture landing view and report request success/failure around the existing form flow.
- Capture report view and section changes from the report dashboard.
- Capture existing export and share controls without changing their behavior.
- Add setup documentation and environment examples without credentials.

## Acceptance criteria

1. Build, typecheck, lint, and tests pass with no PostHog environment variables.
2. Missing configuration causes no network calls and no user-visible errors.
3. Unit tests prove unsafe property keys and unsafe enum values are dropped.
4. Unit tests prove URLs, query strings, domains, report IDs, and free text cannot pass the adapter.
5. Report creation and report page behavior are unchanged if analytics throws.
6. Session replay is false by default and maximum-privacy masked when explicitly enabled.
7. The task receives a strict verified Fable 5 decision review and code review before merge.

## Research sources

- PostHog Next.js guide: https://posthog.com/docs/libraries/next-js
- PostHog data collection controls: https://posthog.com/docs/privacy/data-collection
- PostHog replay privacy controls: https://posthog.com/docs/session-replay/privacy
- PostHog pricing: https://posthog.com/pricing
- Umami overview: https://docs.umami.is/docs/about
- Plausible overview: https://plausible.io/about
- OpenPanel product analytics: https://openpanel.dev/features
- Matomo features: https://matomo.org/features/

## Fable decision review

Verified Claude Fable 5 approved PostHog Cloud EU behind a provider-neutral
adapter. The review agreed with explicit events, EU ingestion, cookieless mode,
no person profiles, no identifiers or report content, and replay disabled by
default. It highlighted one intentional limitation: anonymous cookieless IDs
rotate, so this release measures same-session/day funnels and aggregate feature
usage rather than meaningful person-level multi-day retention.

The strict implementation review returned `PASS`. Its only defense-in-depth
advice was to strip top-level person-update fields independently of the SDK's
`person_profiles: "never"` behavior and to test that unknown SDK event names are
dropped. Both hardening changes were applied before publication. The review
also noted that replay events are intentionally dropped by the event allowlist;
session replay must therefore remain disabled until a separate privacy-reviewed
implementation task changes that transport boundary.
