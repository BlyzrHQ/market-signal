# Explicit report sharing and report workspace layout

## Outcome

Keep every hosted workspace report private by default. An authenticated owner may deliberately publish a completed report through a separate, revocable public share URL. Unsharing invalidates that URL immediately; sharing again creates a new URL. The private workspace URL never becomes a public capability.

At the same time, simplify the report workspace layout so report-level controls live in the report header, product-only controls stay in the product toolbar, and desktop/mobile navigation remains readable after adding the share state.

## Product rules

- Hosted reports with a workspace owner are private by default.
- A private report is available only to the owning workspace at `/reports/{publicReportId}`.
- Sharing creates a cryptographically random 256-bit token and a distinct `/shared/{token}` URL.
- Public readers never receive the private report id, workspace id, billing identity, report history, watcher state, monitoring balance, or share-management controls.
- Unsharing revokes the active token. Re-sharing creates a new token, so an older public URL stays dead.
- Only an authenticated member of the report's owning workspace may share or unshare it. Current hosted workspaces are personal owner workspaces; the authorization boundary remains workspace ownership rather than possession of the private URL.
- Only non-expired terminal reports with a saved document (`complete` or `limited`) may be shared. Failed, interrupted, queued, running, or expired reports remain private.
- Shared responses are revalidated/no-store so revocation cannot be defeated by an immutable CDN cache.
- Shared pages and APIs send `X-Robots-Tag: noindex, nofollow, noarchive` and `Referrer-Policy: same-origin`; the HTML page also declares noindex metadata.
- Shared product-match pagination is readable only through the active share token and preserves the same fact/publication gates as the private report.
- Hosted legacy rows without a workspace are not made newly public by this feature. Existing self-hosted/billing-disabled installations retain their local report-read behavior so open-source setup is not broken.
- Share and unshare actions are audited without storing cookies, credentials, capability tokens, or customer-visible fixture data. Audit rows reference the share row and rotation ordinal rather than the raw token.

## Layout changes

- Move sharing out of the product comparison toolbar and into a report-level header control.
- Replace “Copy workspace link” with an explicit private/public state: `Private`, `Share report`, `Copy public link`, and `Make private`.
- Keep CSV export and comparison-layout selection together as product-only actions.
- Group header actions consistently and allow them to wrap into a dedicated second row on narrow screens instead of compressing the title and status.
- Public shared reports show a clear read-only `Shared report` badge and omit private sidebar modules such as report history and price watch.
- Preserve English/Arabic direction, keyboard navigation, focus handling, and sticky offsets on desktop, tablet, and mobile.

## Persistence and API

- Add a one-row-per-report share-state table containing the active token, active/revoked state, actor, and timestamps, plus an append-only share audit table.
- Add an authenticated same-origin report-sharing endpoint for reading state and sharing/unsharing.
- Add read-only public shared-report and shared-match endpoints keyed only by the active token.
- Extend the reusable report renderer with an explicit workspace/shared mode rather than inferring public access in client code.
- Treat tokens as capability URLs: validate exact lowercase 64-hex shape, compare through indexed equality, never log them, and remove them from any response other than the authenticated share-state response.
- Build public payloads from a positive allowlist. Shared report reads may contain only the report domain, locale, terminal status, safe completion timestamps, the saved report document, and explicitly public presentation fields. They must not contain run ids, private report ids, workspace or billing ids, raw error/event metadata, watcher state, or any fields added to the private model later unless separately allowlisted.

## Validation

- Store tests cover default privacy, idempotent share, revoke, token rotation, terminal-only sharing, wrong-workspace denial, expiry, and audit records.
- Route tests cover authentication, same-origin mutation checks, non-enumerating 404s, private cache headers, public token reads, revoked-token reads, and sanitized payloads.
- Match-route tests prove that the private report id alone never bypasses ownership and that only the active public token exposes accepted match facts.
- Rendered tests cover the relocated controls, private/public state wording, public read-only mode, and responsive layout rules.
- The full typecheck, build, lint, migration generation, and test suite must pass.
- Production verification must show a private report returning 404 anonymously, one deliberately shared test report opening through its share URL, the private URL staying private, and the old share URL returning 404 after revocation. Do not launch a report evaluation or a high-volume crawl for this acceptance check.

## Architecture review

- Verified Fable 5 reviewed the existing authorization, caching, renderer, schema, and self-hosted boundaries before implementation.
- Result: `FABLE_REPORT_SHARING_ARCH_PASS` with no BLOCKER or HIGH finding.
- Incorporated advisories: noindex controls, allowlisted public payloads, token-free audits, referrer hardening, and an explicit expired-report share gate.

## Implementation validation

- `npm test`: PASS — 1,165 tests passed, including the complete Vinext build, TypeScript checks, private-report authorization, sharing routes/store, and generated-migration coverage.
- `npm run lint`: PASS with one pre-existing `next/image` advisory and no errors.
- Node-target Vinext build: PASS; `scripts/assert-vps-build.mjs` confirmed no Wrangler metadata and an external native SQLite driver. The linked local dependency tree did not expose the existing `cross-env` binary shim, so the same build command was invoked through the installed package entry point before running the assertion.
- Production-style local HTTP check: `/shared/{token}` returned `Cache-Control: no-store`, `Referrer-Policy: same-origin`, `X-Robots-Tag: noindex, nofollow, noarchive`, plus matching title/referrer/robots metadata in HTML.
- Automated screenshot inspection could not initialize because the Codex browser runtime returned `failed to write kernel assets: The system cannot find the path specified. (os error 3)`. Responsive behavior remains covered by renderer/CSS assertions and requires a final live acceptance check after deployment.

## Delivery

- Branch: `codex/report-sharing-layout`
- Fable 5 reviews the product/authorization design before implementation and the exact implementation head before merge.
- Deploy Trigger first only if a shared Trigger contract changes. Otherwise deploy the exact reviewed merge commit through the protected VPS workflow and verify HTTPS plus authorization boundaries.
