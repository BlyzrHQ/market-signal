# MCP OAuth well-known routing on Vinext

## Problem

The OAuth implementation merged in PR #205 and deployed at
`5d77980c6864edbe2b58c870585b37d2a3fba108`. The application and Better Auth
OAuth endpoints were healthy, but both root discovery documents returned HTTP
404. Inspection of the exact production build showed that Vinext 0.0.50 ignored
the dot-prefixed `app/.well-known` directory when generating its route table.

## Scope

- Keep the standards-required public URLs under `/.well-known/*`.
- Add routable internal handlers under `/api/mcp/*`.
- Rewrite only the three exact OAuth discovery paths to those handlers.
- Assert against the built Vinext server artifact so a source-only test cannot
  miss another omitted route.
- Do not run a report, evaluation, product search, or price-watch check.

## Validation

- Run the focused OAuth tests, type checks, build, lint, and full test suite.
- Verify the built server contains the internal route handlers and exact
  well-known rewrites.
- Obtain strict Fable 5 review on the exact PR head.
- Deploy the exact merged commit and verify all three public discovery URLs.
