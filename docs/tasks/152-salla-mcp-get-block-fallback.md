# Task 152 — Salla MCP recovery when discovery GETs are blocked

## Problem

The production VPS receives HTTP 403 from Salla storefront GET requests,
including the public MCP server card, while the same storefront's `/mcp`
JSON-RPC endpoint remains publicly accessible. The current recovery requires the
server card before calling MCP, so a usable catalog is discarded and the report
ends as `primary-page-unavailable`.

## Scope

- Retain server-card discovery as the preferred verification path.
- When the card cannot be read, call the standard MCP `initialize` method on the
  exact submitted HTTPS domain.
- Accept the fallback only when the response uses the supported protocol and
  identifies a Salla storefront server.
- Continue requiring `store://info` to identify the exact submitted domain and
  a valid country before accepting any products.
- Record `/mcp` as the evidence source when initialize is the discovery path.
- Add regression coverage for blocked discovery GETs and fail-closed identity
  validation.

## Validation

- Focused Salla recovery tests.
- Full test, VPS build, lint, Go test, and Go vet gates.
- Strict reviewer pass on the exact head.
- Trigger deployment before VPS deployment.
- Fresh `asalbarri.sa` report with observed priced products.
