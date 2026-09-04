# Company CLI landing page

## Request

Replace the old customer login onboarding at /cli with the external company-agent
CLI commands and an accurate explanation. Keep existing customer CLI capabilities
available separately; do not modify auth, quotas, installer or Trigger tasks.
This branch starts from master and does not depend on unmerged PR #222.

## Changes

- Remove account/pricing links, browser login commands, customer API-key setup,
  and customer installer/download links from this page.
- Show company report/wait/result commands, request-ID rules and JSON contents.
- Clearly distinguish a requested comparison count from actual coverage.
- Explain existing transport: company CLI -> report service -> Trigger.dev.
- Explain one-time operator-provisioned executable/credential setup; do not
  imply raw Trigger keys belong on agent machines or that access is anonymous.
- Keep the existing visual style and add regression checks for the page boundary.

## Validation / release

Pending: Node tests, lint, VPS build, CLI command-help validation, local rendered
page checks, exact-head Fable review, focused draft PR and production deployment.
No paid reports are needed for this documentation-only page change. Use the real
public /cli endpoint for deployed-page verification. Do not call it live until
the approved commit is deployed and its page is verified.
