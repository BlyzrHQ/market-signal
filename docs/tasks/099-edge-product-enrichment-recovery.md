# Task 099 — Edge product enrichment recovery

## Problem

The Babanuj report discovers public product URLs, but the VPS cannot reliably read Babanuj's `robots.txt` during the selected-product enrichment phase. The enricher consequently skips the exact product pages and the report table shows no primary images or prices even though those pages publish valid JSON-LD images and offers.

## Scope

- Keep the VPS as the report orchestrator and durable database owner.
- When selected-product enrichment on the VPS is blocked specifically by an unreachable robots policy, retry only those bounded targets through the fixed Sites enrichment endpoint.
- Never bypass a published robots disallow rule.
- Prevent Sites-to-Sites recursion and do not transmit internal callback credentials.
- Validate recovered product identity, source domain, source URL, and bounded coverage before merging it.
- Record edge recovery in enrichment coverage so the data path remains visible.

## Acceptance

- Automated tests prove zero edge egress outside the exact VPS/unreachable-robots condition.
- Automated tests prove no authorization or internal callback secret is sent.
- Mismatched or malformed edge results are rejected.
- Existing tests, lint, typecheck, and builds pass.
- A fresh Babanuj report displays first-party images and prices for selected comparison rows whose exact public product pages expose them.
- Strict Fable 5 review returns PASS before merge.

## Architecture decision

Verified Fable 5 approved a route-boundary fallback that forwards only machine-typed `robots_unreachable` targets to one hardcoded Sites endpoint. The fallback is gated to the Node deployment, requires a local callback token only as an untransmitted enablement check, sends no authorization or marker header, performs one bounded request, and rejects the whole response unless every returned product matches an original ID, canonical domain, and canonical source URL. Robots-disallowed and ordinary fetch-failure targets are never eligible.

Rejected alternatives included forwarding the full batch, proxying only `robots.txt`, moving fallback logic into Trigger, treating unreachable robots as missing, and configurable/per-target edge calls.

## Validation

- Real public probe: the Sites enrichment endpoint returned the exact Babanuj `zaitoune-maamoul-date-250g` product with a Shopify CDN image and an observed `USD 10.8` offer.
- Focused route, recovery, storefront, and VPS packaging tests: 52 passed.
- Full suite: 476 passed, 0 failed.
- Typecheck and production build: passed.
- ESLint: 0 errors; two pre-existing `no-img-element` warnings.
