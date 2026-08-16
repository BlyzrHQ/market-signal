# Task 150 — Official Salla MCP catalog recovery

## Problem

The fresh `asalbarri.sa` report reached the corrected terminal-accounting path but
still failed its crawl. Both the VPS IPv4 crawler and Sites edge returned no
usable homepage, while the public site advertised an official Salla storefront
MCP endpoint. That endpoint returned observed store identity, catalog products,
product URLs, images, positive SAR prices, and bounded pagination.

## Decision

- Keep normal HTML, robots, sitemap, and edge recovery as the primary paths.
- When the primary homepage remains unavailable, probe only the submitted
  domain's exact `/.well-known/mcp/server-card.json` path.
- Accept recovery only when the card identifies Salla and declares the exact
  same-origin `/mcp` streamable-HTTP endpoint.
- Read only `store://info` and call only the read-only
  `catalog-product-list` tool. Do not call cart, checkout, or mutating tools.
- Reuse the DNS-pinned public fetch boundary for JSON-RPC POST requests, with
  same-domain redirect enforcement, short timeouts, bounded request and response
  bodies, a fixed protocol version, and no credentials or cookies.
- Whitelist the observed store and product fields used by Market Signal. Reject
  cross-domain store/product identity, malformed prices, unsupported currency,
  unsafe image URLs, untrusted cursor URLs, duplicate products, and oversized
  pagination.
- Bound catalog collection to the persisted report plan's product limit (maximum
  1,000) and expose the Salla source and fallback reason as a visible evidence
  gap. Keep facts labeled as observed storefront-API records.

## Acceptance

- Focused tests cover verified recovery, positive SAR prices, images, cursor
  pagination, plan bounds, JSON-RPC transport, bad server identity, cross-domain
  identity, and untrusted cursors.
- Full test, typecheck, production build, and lint gates pass.
- Strict Fable 5 review reports no blockers on the exact head.
- Deploy Trigger, Sites, and the exact VPS commit.
- A fresh `asalbarri.sa` report persists observed products and reaches a truthful
  terminal state without charging a failed run. Published comparisons must retain
  finite positive supported-currency rival prices.

## Data boundary

This fallback uses the store's official unauthenticated public Salla interface.
It does not send customer credentials, use checkout tools, or infer missing
prices. A missing or invalid official response remains a visible crawl gap.
