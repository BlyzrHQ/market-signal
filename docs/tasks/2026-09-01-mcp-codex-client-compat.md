# Codex MCP client compatibility

## Problem

Market Signal advertises strict MCP Client ID Metadata Document (CIMD) registration and deliberately keeps anonymous Dynamic Client Registration disabled. Codex can use its official self-referential client metadata document, but production rejects that client before consent with `invalid_client` because the pinned Node metadata transport throws `ERR_INVALID_IP_ADDRESS` on Node 22's all-address custom DNS callback shape.

This is an OAuth transport compatibility defect. It does not affect report data, plan quota, comparison search, or price-watch credits.

## Security boundary

- Keep anonymous Dynamic Client Registration disabled.
- Accept only HTTPS metadata documents validated by the existing strict MCP 2026-07-28 CIMD profile.
- Resolve the metadata hostname exactly once, reject every special-use DNS answer, and pin one approved address to the TLS connection.
- Preserve the original hostname for HTTP Host, TLS SNI, and certificate verification.
- Refuse redirect following and retain Better Auth's five-second, 5 KiB, cache, concurrency, and rate limits.
- Request only `reports:read` for the first live Codex verification. Do not create reports or mutate price watchers.

## Implementation

1. Replace the affected package transport with a local Node 22-compatible pinned transport.
2. Disable automatic address-family racing for the already pinned connection and support both Node custom-lookup callback shapes.
3. Prefer a validated IPv4 answer when one exists so an IPv6 DNS answer does not require VPS IPv6 reachability.
4. Add deterministic callback-shape regressions and an opt-in real-network probe against Codex's official metadata document.
5. Validate the complete authorization route with Codex's official client identifier and a dynamic loopback callback before production rollout.

## Acceptance criteria

- The transport no longer throws `ERR_INVALID_IP_ADDRESS` under the repository's supported Node 22 runtime.
- Codex's official metadata document is fetched as JSON through a resolve-once, pinned, non-redirecting HTTPS connection.
- A `reports:read` authorization request using `https://chatgpt.com/oauth/codex/client.json` reaches login/consent instead of `invalid_client`.
- OAuth discovery continues to advertise CIMD and no registration endpoint.
- Focused tests, typechecks, build, full tests, lint, and `git diff --check` pass.
- Strict high-risk review, merge, exact-revision deployment, and production read-only verification remain mandatory before completion.

## Validation record

- Reproduced the production rejection with Codex's official client ID: the authorization endpoint returned `invalid_client` because the package transport could not fetch the metadata document.
- Reproduced the underlying package failure directly under Node 22.18.0 as `ERR_INVALID_IP_ADDRESS`.
- Focused deterministic transport and OAuth tests passed; non-HTTPS and private destinations remain rejected.
- Opt-in real-network validation passed against `https://chatgpt.com/oauth/codex/client.json`, including a signed-in `reports:read` authorization request reaching Market Signal consent with a dynamic loopback port (12/12 focused tests).
- Application and Node typechecks passed.
- Full application build and test suite passed: 1,269 passed, 0 failed, and 2 opt-in network tests skipped in the default offline run.
- VPS production build passed; `better-sqlite3` remains external as required.
- Lint passed with the pre-existing `app/components/product-design-lab.tsx` raw-image warning and no errors.
- `git diff --check` passed with only Windows line-ending notices.
- Strict high-risk review, merge, exact-revision deployment, and production read-only report retrieval remain pending.
