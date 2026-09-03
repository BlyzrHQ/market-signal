# Customer CLI browser and API-key login

## Goal

Turn the report CLI into a customer-ready hosted experience:

```text
marketsignal login
marketsignal report example.com
```

Interactive use must not require Go, Node.js, a local Market Signal server, or
the deployment-wide controlled-service token after installation. Agent loops
may instead receive one revocable workspace API key.

## Dependency

This task is stacked on `codex/loop-cli-contract` / PR #217. The durable
submit, wait, result, private ownership, and normalized comparison contracts in
that PR remain the data-plane boundary.

## Architecture decision

- Reuse the hosted Better Auth OAuth 2.1 authorization server.
- Register one first-party public native client at
  `https://signal.blyzr.com/cli`.
- Use Authorization Code with S256 PKCE and an ephemeral
  `127.0.0.1` callback port. The provider's installed implementation was
  inspected and explicitly implements RFC 8252 loopback port variance.
- Issue tokens only for the distinct protected resource
  `https://signal.blyzr.com/api`. An MCP-audience token must never authorize
  REST report routes, and a CLI-audience token must never authorize MCP.
- Grant only `reports:read`, `reports:create`, and `offline_access` in this
  release. Price-watch scopes are not bundled into CLI login.
- Keep access tokens short-lived and refresh tokens rotating. Store the
  credential in the operating-system credential store, keyed by the exact
  issuer origin. Never write tokens to repository files, shell profiles, or
  command arguments.
- Keep report plan, report quota, workspace ownership, and idempotency
  authoritative on the server.
- Support a second, explicit API-key path for unattended agents. Store only a
  SHA-256 digest of a 256-bit random secret, display plaintext once, allow
  read-only or create-and-read scope, expire keys after 30/90/365 days, and cap
  each workspace at ten active keys.

## Security invariants

- Hosted billing never accepts `MARKET_SIGNAL_API_TOKEN` as a customer bypass.
- The browser flow uses high-entropy state and verifier values, S256 PKCE,
  exact issuer validation, one callback, a bounded timeout, and a loopback-only
  listener.
- Saved credentials are attached only to the exact origin that issued them.
- Hosted `msk_live_` keys are never sent to an overridden base URL, never
  accepted as command arguments, and never replace the deployment-wide
  self-hosted token.
- Every hosted REST request verifies EdDSA signature, issuer, exact API
  audience, expiry, first-party client id, consent, active rotating grant,
  supported scope, user identity, and workspace membership.
- Report creation requires `reports:create`; result and comparison reads
  require `reports:read`.
- CLI requests are rate-limited by workspace and client in addition to normal
  subscription/report reservations.
- Connected-app revocation and `marketsignal logout` invalidate the grant.
- API-key logout calls a key-authenticated self-revoke endpoint before deleting
  the operating-system credential. Dashboard creation/revocation requires a
  signed-in owner and a same-origin mutation.
- Reports remain private and inaccessible across workspaces.

## CLI behavior

- Default to `https://signal.blyzr.com`.
- `login` opens the browser and always prints the URL as a fallback.
- `report <domain>` generates a request id, submits once, waits, and emits the
  existing validated human or JSON loop result.
- `submit`, `wait`, and `result` remain available for orchestrators.
- `logout` revokes the refresh grant before deleting the local credential.
- `MARKET_SIGNAL_API_TOKEN` remains an explicit override only for local or
  controlled non-hosted deployments.
- `MARKET_SIGNAL_API_KEY` is the only non-interactive hosted key input;
  `login --api-key` uses a no-echo terminal prompt and stores it in the
  operating-system credential store.

## Distribution

- Cross-build Windows amd64 and arm64 binaries in contributor CI and in the
  production image from the exact deployed revision.
- Serve a SHA-256 manifest next to the production image's binaries.
- Provide a PowerShell installer that installs the selected binary under the
  current user's local application directory and updates the user PATH without
  requiring administrator access.
- Disclose that this first preview is not yet Authenticode-signed; code signing
  remains a release-hardening follow-up rather than an implied guarantee.

## Validation

- Unit-test PKCE, state and issuer rejection, callback timeout, origin binding,
  token refresh rotation, credential deletion, and browser-launch fallback.
- Integration-test the real Better Auth authorization-code and refresh-token
  flow with the pre-registered CLI client and separate API audience.
- Test hosted bearer authorization, scope separation, rate limits, tenant
  isolation, plan quota, revocation, and rejection of MCP-audience tokens.
- Test one-time API-key disclosure, hashing, exact-origin binding, expiry,
  read-only scope, tenant-bound management, rate limits, and self-revocation.
- Run Go tests/vet, TypeScript checks, lint, production/VPS builds, full tests,
  workflow validation, and `git diff --check`.
- Treat this authentication change as high-risk. Require a strict Fable review
  or two independent blocker-focused Codex reviewers before merge, in addition
  to Codex's own validation.
- Deploy the exact merged Trigger version before the exact merged VPS commit,
  verify health and OAuth metadata, and perform only a bounded Starter report
  acceptance run with known cost controls.

## Architecture review

Claude Code reviewed the pre-implementation decision read-only on 2026-09-03.
It recommended extending the existing OAuth 2.1 server with a separate API
resource, first-party native client, S256 PKCE loopback flow, OS-protected
credential storage, exact-origin binding, REST rate limiting, connected-app
revocation, and explicit separation from the MCP audience. It rejected static
personal keys and reuse of the MCP audience. Codex independently verified the
installed provider's RFC 8252 loopback-port matching and multi-resource
support; no tests were attributed to Claude.

The user subsequently required a static key option for external loops. A
second read-only Claude architecture review on 2026-09-03 accepted the random
secret and hash-at-rest design but identified required hardening: distinct
credential kinds, exact production-origin binding, key-authenticated logout,
strict same-origin management, explicit scope/expiry, and per-key/workspace
rate limits. Those controls are part of this task. This deliberately accepts a
longer-lived credential without OAuth consent or refresh rotation in exchange
for unattended use; narrow scopes, expiry, one-time disclosure, server-owned
quota, and immediate revocation bound that trade-off.

## Implementation validation

- `npm test`: **PASS**, 1,327 tests passed with zero failures after the
  production build and complete TypeScript checks.
- `npm run lint`: **PASS**, zero errors; one pre-existing `next/image` advisory
  remains in `app/components/product-design-lab.tsx`.
- `npm run test:open-source`: **PASS** with a credential-free local startup.
- `npm run build:vps`: **PASS**, including the Node runtime and external SQLite
  assertions.
- `go test ./...` and `go vet ./...`: **PASS**.
- Windows amd64 and arm64 cross-builds: **PASS**; the amd64 binary executed and
  exposed the intended `login --api-key` help without showing a credential
  argument form.
- Focused OAuth, API-key, report-route, and distribution suite: **PASS**, 27
  tests. API-key coverage includes one-time disclosure, digest-only storage,
  owner/tenant binding, scope, expiry, active-key cap, rate limits, exact-key
  self-revocation, and cross-origin mutation rejection.
- Local Docker image execution remains unavailable because this workstation's
  Docker Linux engine is not running. The Dockerfile cross-build path is
  covered by contributor CI and must pass on the published PR before merge.
- Exact-commit review, CI, deployment, and production endpoint verification
  remain release gates; no live report was launched during local validation.
