# Task: remove residual Sites artifacts

## Objective

Keep the supported production topology limited to the Market Signal VPS at
`signal.blyzr.com` and Trigger.dev. Remove obsolete active files and wording
left behind after the former Sites runtime was retired.

## Scope

- Remove the obsolete authenticated live-panel runner that targeted the former
  hosted runtime.
- Remove stale Docker ignore exceptions and platform-specific reverse-proxy
  wording. Preserve the fail-closed stripping of obsolete identity headers.
- Remove active documentation and execution-rule references to the retired
  platform.
- Preserve a regression guard that prevents retired hosting files or domains
  from returning to active operations files.
- Preserve completed task documents as historical release evidence.

## Acceptance

- Active source, configuration, scripts, and current documentation contain no
  dependency on the retired runtime.
- Production instructions name only the VPS and Trigger.dev deployment path.
- The VPS build, full Node test suite, lint, and Go CLI checks pass.
- A strict verified Fable 5 review reports no blockers on the exact PR head.

## Operational boundary

This cleanup does not change report behavior, crawling, billing, customer data,
or secrets. It removes obsolete deployment surface only. No deployment to the
retired platform is performed.
