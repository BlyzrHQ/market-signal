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

Initial validation passed: 1341 Node tests including typechecks/build, lint with
one pre-existing img warning, VPS build, CLI command-help validation. Local
production /cli returned HTTP 200 with company commands and no login/account
links. The browser webview could not attach; no screenshot pass is claimed.
PR #223 is draft; final review, CI and production deployment remain pending.
No paid reports are needed for this documentation-only page change. Use the real
public /cli endpoint for deployed-page verification. Do not call it live until
the approved commit is deployed and its page is verified.

## Review

Fable 5.1 found the customer account install link still pointing to /cli.
Retargeted it to the existing downloadable customer installer and added a test;
customers are no longer sent to the internal-only guide. The customer OAuth
client identifier remains /cli for compatibility, but it is an identifier, not
an install/help link; no client metadata, authentication or grants are changed.
This page intentionally no longer serves customer onboarding per user request.
