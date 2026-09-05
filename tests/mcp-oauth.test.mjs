import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decodeJwt, decodeProtectedHeader } from "jose";
import { signJWT } from "better-auth/plugins";

import { createAccountAuth } from "../app/lib/account-auth.ts";
import {
  hostedMcpEnabled,
} from "../app/lib/mcp-oauth-config.ts";
import {
  CLI_ACCESS_TOKEN_TTL_SECONDS,
  CLI_AUTHORIZATION_SCOPES,
  CLI_CLIENT_ID,
  CLI_REGISTERED_REDIRECT_URI,
  CLI_RESOURCE,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_AUTHORIZATION_SCOPES,
  MCP_RESOURCE,
} from "../app/lib/mcp-oauth-shared.ts";
import {
  authorizeCliClaims,
  authorizeMcpClaims,
  listConnectedMcpApps,
  revokeConnectedMcpApp,
} from "../app/lib/mcp-oauth-store.ts";
import {
  McpAccessTokenError,
  verifyCliAccessToken,
  verifyMcpAccessToken,
} from "../app/lib/mcp-token-verifier.ts";
import { ReportApiAuthorizationError, reportApiAccountContext } from "../app/lib/report-api-auth.ts";

const BASE_URL = "https://signal.blyzr.com";
const CALLBACK_URL = "http://127.0.0.1:45891/callback";
const CODEX_CLIENT_ID = "https://chatgpt.com/oauth/codex/client.json";
const TEST_CLIENT_ID = "market-signal-standards-harness";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-mcp-oauth-"));
  const databasePath = join(directory, "market-signal.sqlite");
  const auth = await createAccountAuth({
    baseURL: BASE_URL,
    databasePath,
    mcpEnabled: true,
    secret: "a-high-entropy-mcp-oauth-test-secret-with-more-than-thirty-two-characters",
  });
  await auth.$context;
  return { auth, database: auth.options.database, databasePath, directory };
}

function hostedEnvironment(databasePath) {
  return {
    MARKET_SIGNAL_DEPLOY_TARGET: "node",
    MARKET_SIGNAL_HOSTED_BILLING: "true",
    MARKET_SIGNAL_SQLITE_PATH: databasePath,
    BETTER_AUTH_URL: BASE_URL,
    BETTER_AUTH_SECRET: "a-high-entropy-mcp-oauth-test-secret-with-more-than-thirty-two-characters",
    STRIPE_RESTRICTED_KEY: `rk_test_${"a".repeat(24)}`,
    STRIPE_WEBHOOK_SECRET: `whsec_${"b".repeat(24)}`,
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_SOLO: "price_solo",
    STRIPE_PRICE_GROWTH: "price_growth",
    STRIPE_PRICE_AGENCY: "price_agency",
  };
}

function registerTestClient(database) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO oauthClient (
      id, clientId, clientDiscoveryId, disabled, scopes, clientCredentialsScopes,
      createdAt, updatedAt, name, redirectUris, tokenEndpointAuthMethod,
      grantTypes, responseTypes, requirePKCE, dpopBoundAccessTokens
    ) VALUES (?, ?, NULL, 0, ?, '[]', ?, ?, ?, ?, 'none', ?, ?, 1, 0)
  `).run(
    randomUUID(),
    TEST_CLIENT_ID,
    JSON.stringify(MCP_AUTHORIZATION_SCOPES),
    now,
    now,
    "Standards conformance harness",
    JSON.stringify([CALLBACK_URL]),
    JSON.stringify(["authorization_code", "refresh_token"]),
    JSON.stringify(["code"]),
  );
  database.prepare(`
    INSERT INTO oauthClientResource (id, clientId, resourceId, createdAt)
    VALUES (?, ?, ?, ?)
  `).run(randomUUID(), TEST_CLIENT_ID, MCP_RESOURCE, now);
}

async function signUp(auth) {
  const response = await auth.handler(new Request(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({
      name: "MCP Test User",
      email: "mcp@example.test",
      password: "secure-password-123",
    }),
  }));
  assert.equal(response.status, 200, await response.text());
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

async function issueTokens(auth, cookie) {
  const verifier = "standards-harness-code-verifier-with-more-than-forty-three-characters-123";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${BASE_URL}/api/auth/oauth2/authorize`);
  authorize.searchParams.set("client_id", TEST_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", CALLBACK_URL);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "offline_access reports:read price_watch:read");
  authorize.searchParams.set("state", "mcp-state");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("resource", MCP_RESOURCE);
  authorize.searchParams.set("prompt", "consent");
  const authorizeResponse = await auth.handler(new Request(authorize, {
    headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
  }));
  assert.equal(authorizeResponse.status, 302, await authorizeResponse.text());
  const consentLocation = authorizeResponse.headers.get("location");
  assert.ok(consentLocation, "missing consent redirect");
  const consentURL = new URL(consentLocation, BASE_URL);
  assert.equal(consentURL.origin + consentURL.pathname, `${BASE_URL}/oauth/consent`);

  const signedQuery = consentURL.search.slice(1);
  const consentResponse = await auth.handler(new Request(`${BASE_URL}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ accept: true, oauth_query: signedQuery }),
  }));
  assert.equal(consentResponse.status, 200, await consentResponse.clone().text());
  const consentResult = await consentResponse.json();
  const callback = new URL(consentResult.redirect_uri || consentResult.url);
  assert.equal(callback.origin + callback.pathname, CALLBACK_URL);
  assert.equal(callback.searchParams.get("state"), "mcp-state");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: TEST_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: CALLBACK_URL,
    resource: MCP_RESOURCE,
  });
  const tokenResponse = await auth.handler(new Request(`${BASE_URL}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
    body: tokenBody,
  }));
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  return tokenResponse.json();
}

async function refreshGrant(auth, refreshToken) {
  const response = await auth.handler(new Request(`${BASE_URL}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: TEST_CLIENT_ID,
      refresh_token: refreshToken,
      resource: MCP_RESOURCE,
    }),
  }));
  return response;
}

async function refreshCliGrant(auth, refreshToken) {
  return auth.handler(new Request(`${BASE_URL}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLI_CLIENT_ID,
      refresh_token: refreshToken,
      resource: CLI_RESOURCE,
    }),
  }));
}

async function issueCliTokens(auth, cookie, port = 45892) {
  const callbackURL = `http://127.0.0.1:${port}/callback`;
  const verifier = "market-signal-cli-code-verifier-with-more-than-forty-three-characters-123";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${BASE_URL}/api/auth/oauth2/authorize`);
  authorize.searchParams.set("client_id", CLI_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callbackURL);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", CLI_AUTHORIZATION_SCOPES.join(" "));
  authorize.searchParams.set("state", "cli-state");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("resource", CLI_RESOURCE);
  authorize.searchParams.set("prompt", "consent");
  const authorizeResponse = await auth.handler(new Request(authorize, {
    headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
  }));
  assert.equal(authorizeResponse.status, 302, await authorizeResponse.text());
  const consentLocation = authorizeResponse.headers.get("location");
  assert.ok(consentLocation, "missing CLI consent redirect");
  const consentURL = new URL(consentLocation, BASE_URL);
  assert.equal(consentURL.origin + consentURL.pathname, `${BASE_URL}/oauth/consent`);

  const consentResponse = await auth.handler(new Request(`${BASE_URL}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ accept: true, oauth_query: consentURL.search.slice(1) }),
  }));
  assert.equal(consentResponse.status, 200, await consentResponse.clone().text());
  const consentResult = await consentResponse.json();
  const callback = new URL(consentResult.redirect_uri || consentResult.url);
  assert.equal(callback.origin + callback.pathname, callbackURL);
  assert.equal(callback.searchParams.get("state"), "cli-state");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await auth.handler(new Request(`${BASE_URL}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLI_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: callbackURL,
      resource: CLI_RESOURCE,
    }),
  }));
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  return tokenResponse.json();
}

test("hosted MCP activates only on the canonical billed production deployment", () => {
  const environment = {
    MARKET_SIGNAL_HOSTED_BILLING: "true",
    STRIPE_RESTRICTED_KEY: `rk_test_${"a".repeat(24)}`,
    STRIPE_WEBHOOK_SECRET: `whsec_${"b".repeat(24)}`,
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_SOLO: "price_solo",
    STRIPE_PRICE_GROWTH: "price_growth",
    STRIPE_PRICE_AGENCY: "price_agency",
  };
  assert.equal(hostedMcpEnabled(environment, BASE_URL), true);
  assert.equal(hostedMcpEnabled(environment, "https://self-hosted.example"), false);
  assert.equal(hostedMcpEnabled({ ...environment, MARKET_SIGNAL_HOSTED_BILLING: "false" }, BASE_URL), false);
  assert.equal(hostedMcpEnabled({ ...environment, STRIPE_PRICE_AGENCY: "" }, BASE_URL), false);
});

test("OAuth metadata advertises CIMD, exact resource scopes, PKCE, and no DCR", async () => {
  const { auth, database, directory } = await fixture();
  try {
    const metadata = await auth.api.getOAuthServerConfig({ headers: new Headers() });
    assert.equal(metadata.issuer, BASE_URL);
    assert.equal(metadata.authorization_endpoint, `${BASE_URL}/api/auth/oauth2/authorize`);
    assert.equal(metadata.token_endpoint, `${BASE_URL}/api/auth/oauth2/token`);
    assert.equal(metadata.registration_endpoint, undefined);
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.deepEqual(metadata.scopes_supported, [...MCP_AUTHORIZATION_SCOPES]);
    assert.deepEqual(
      database.prepare("SELECT identifier, accessTokenTtl, signingAlgorithm, allowedScopes FROM oauthResource WHERE identifier = ?").get(MCP_RESOURCE),
      {
        identifier: MCP_RESOURCE,
        accessTokenTtl: MCP_ACCESS_TOKEN_TTL_SECONDS,
        signingAlgorithm: "EdDSA",
        allowedScopes: JSON.stringify(MCP_AUTHORIZATION_SCOPES),
      },
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("official Codex CIMD client reaches consent with a dynamic loopback port", {
  skip: process.env.MARKET_SIGNAL_TEST_CIMD_NETWORK !== "1",
}, async () => {
  const { auth, database, directory } = await fixture();
  try {
    const cookie = await signUp(auth);
    const verifier = "codex-client-compatibility-verifier-with-more-than-forty-three-characters";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${BASE_URL}/api/auth/oauth2/authorize`);
    authorize.searchParams.set("client_id", CODEX_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", CALLBACK_URL);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "reports:read");
    authorize.searchParams.set("state", "codex-client-compatibility");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("resource", MCP_RESOURCE);
    authorize.searchParams.set("prompt", "consent");

    const response = await auth.handler(new Request(authorize, {
      headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
    }));
    assert.equal(response.status, 302, await response.text());
    const location = response.headers.get("location");
    assert.ok(location);
    const consentURL = new URL(location, BASE_URL);
    assert.equal(consentURL.origin + consentURL.pathname, `${BASE_URL}/oauth/consent`);
    assert.equal(
      database.prepare("SELECT clientDiscoveryId FROM oauthClient WHERE clientId = ?").get(CODEX_CLIENT_ID)?.clientDiscoveryId,
      "cimd",
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("authorization code plus S256 issues an audience-bound rotating grant", async () => {
  const { auth, database, directory } = await fixture();
  try {
    registerTestClient(database);
    const cookie = await signUp(auth);
    const tokens = await issueTokens(auth, cookie);
    assert.equal(typeof tokens.access_token, "string");
    assert.equal(typeof tokens.refresh_token, "string");
    assert.equal(tokens.expires_in, MCP_ACCESS_TOKEN_TTL_SECONDS);
    const header = decodeProtectedHeader(tokens.access_token);
    const claims = decodeJwt(tokens.access_token);
    assert.equal(header.alg, "EdDSA");
    assert.equal(typeof header.kid, "string");
    assert.equal(claims.iss, BASE_URL);
    assert.equal(claims.aud, MCP_RESOURCE);
    assert.equal(claims.client_id, TEST_CLIENT_ID);
    assert.equal(claims.scope, "offline_access reports:read price_watch:read");
    assert.equal(typeof claims.jti, "string");
    assert.equal(typeof claims.sid, "string");
    assert.equal(database.prepare("SELECT count(*) AS total FROM oauthRefreshToken WHERE revoked IS NULL").get().total, 1);

    const authInfo = await verifyMcpAccessToken(database, tokens.access_token);
    assert.equal(authInfo.clientId, TEST_CLIENT_ID);
    assert.equal(authInfo.resource.href, MCP_RESOURCE);
    assert.equal(authInfo.extra.workspaceId.length > 0, true);
    assert.equal(authInfo.extra.userId, claims.sub);
    assert.deepEqual(authInfo.scopes, ["offline_access", "reports:read", "price_watch:read"]);
    await assert.rejects(
      () => verifyMcpAccessToken(database, tokens.access_token, new Date((claims.exp + 120) * 1_000)),
      (error) => error instanceof McpAccessTokenError && error.code === "invalid_token",
    );
    const jwtPlugin = auth.options.plugins.find((plugin) => plugin.id === "jwt");
    assert.ok(jwtPlugin?.options);
    const wrongAudienceToken = await signJWT({ context: await auth.$context }, {
      options: jwtPlugin.options,
      header: { typ: "at+jwt" },
      signingAlgorithm: "EdDSA",
      payload: { ...claims, aud: "https://wrong-resource.example/mcp" },
    });
    await assert.rejects(
      () => verifyMcpAccessToken(database, wrongAudienceToken),
      (error) => error instanceof McpAccessTokenError && error.code === "invalid_token",
    );
    const [encodedHeader, encodedPayload, encodedSignature] = tokens.access_token.split(".");
    const tamperedPayload = `${encodedPayload[0] === "a" ? "b" : "a"}${encodedPayload.slice(1)}`;
    await assert.rejects(
      () => verifyMcpAccessToken(database, `${encodedHeader}.${tamperedPayload}.${encodedSignature}`),
      (error) => error instanceof McpAccessTokenError && error.code === "invalid_token",
    );

    const authorized = authorizeMcpClaims(database, claims, ["reports:read"]);
    assert.equal(authorized.ok, true, JSON.stringify({ authorized, claims }));
    assert.equal(authorized.ok && authorized.context.workspaceId.length > 0, true);
    assert.equal(listConnectedMcpApps(database, claims.sub).at(0)?.status, "active");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("first-party CLI login accepts random loopback ports and stays API-audience bound", async () => {
  const { auth, database, databasePath, directory } = await fixture();
  try {
    const client = database.prepare(`
      SELECT clientId, clientSecret, disabled, name, uri, redirectUris,
             tokenEndpointAuthMethod, applicationType, requirePKCE, skipConsent
      FROM oauthClient WHERE clientId = ?
    `).get(CLI_CLIENT_ID);
    assert.deepEqual(client, {
      clientId: CLI_CLIENT_ID,
      clientSecret: null,
      disabled: 0,
      name: "Market Signal CLI",
      uri: CLI_CLIENT_ID,
      redirectUris: JSON.stringify([CLI_REGISTERED_REDIRECT_URI]),
      tokenEndpointAuthMethod: "none",
      applicationType: "native",
      requirePKCE: 1,
      skipConsent: 0,
    });
    assert.deepEqual(
      database.prepare("SELECT identifier, accessTokenTtl, signingAlgorithm, allowedScopes FROM oauthResource WHERE identifier = ?").get(CLI_RESOURCE),
      {
        identifier: CLI_RESOURCE,
        accessTokenTtl: CLI_ACCESS_TOKEN_TTL_SECONDS,
        signingAlgorithm: "EdDSA",
        allowedScopes: JSON.stringify(CLI_AUTHORIZATION_SCOPES),
      },
    );

    const cookie = await signUp(auth);
    const tokens = await issueCliTokens(auth, cookie, 49171);
    const claims = decodeJwt(tokens.access_token);
    assert.equal(claims.aud, CLI_RESOURCE);
    assert.equal(claims.client_id, CLI_CLIENT_ID);
    assert.equal(claims.scope, CLI_AUTHORIZATION_SCOPES.join(" "));
    const authorized = await verifyCliAccessToken(database, tokens.access_token, ["reports:create"]);
    assert.equal(authorized.clientId, CLI_CLIENT_ID);
    assert.equal(authorized.workspaceId.length > 0, true);
    assert.equal(authorized.user.id, claims.sub);
    await assert.rejects(
      () => verifyMcpAccessToken(database, tokens.access_token),
      (error) => error instanceof McpAccessTokenError && error.code === "invalid_token",
    );

    const mcpTokens = await (async () => {
      registerTestClient(database);
      return issueTokens(auth, cookie);
    })();
    await assert.rejects(
      () => verifyCliAccessToken(database, mcpTokens.access_token, ["reports:read"]),
      (error) => error instanceof McpAccessTokenError && error.code === "invalid_token",
    );

    const environment = hostedEnvironment(databasePath);
    const request = new Request(`${BASE_URL}/api/reports`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const context = await reportApiAccountContext(request, environment);
    assert.equal(context?.workspaceId, authorized.workspaceId);
    assert.equal(context?.user.id, claims.sub);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.ok(await reportApiAccountContext(request, environment));
    }
    await assert.rejects(
      () => reportApiAccountContext(request, environment),
      (error) => error instanceof ReportApiAuthorizationError && error.status === 429 && error.errorCode === "rate-limit-exceeded",
    );

    const signOut = await auth.handler(new Request(`${BASE_URL}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: BASE_URL },
      body: "{}",
    }));
    assert.equal(signOut.status, 200, await signOut.text());
    const afterBrowserSignOut = authorizeCliClaims(database, claims, ["reports:read"]);
    assert.equal(afterBrowserSignOut.ok, true, `CLI offline grant should survive browser sign-out: ${JSON.stringify(afterBrowserSignOut)}`);
    assert.equal(
      listConnectedMcpApps(database, claims.sub).find((app) => app.client.clientId === CLI_CLIENT_ID)?.status,
      "active",
    );

    const refreshResponse = await refreshCliGrant(auth, tokens.refresh_token);
    assert.equal(refreshResponse.status, 200, await refreshResponse.clone().text());
    const rotated = await refreshResponse.json();
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);
    assert.equal(decodeJwt(rotated.access_token).sid, null);
    assert.equal((await verifyCliAccessToken(database, rotated.access_token, ["reports:read"])).workspaceId, authorized.workspaceId);

    const revoke = await auth.handler(new Request(`${BASE_URL}/api/auth/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
      body: new URLSearchParams({
        client_id: CLI_CLIENT_ID,
        token: rotated.refresh_token,
        token_type_hint: "refresh_token",
      }),
    }));
    assert.equal(revoke.status, 200, await revoke.text());
    await assert.rejects(
      () => verifyCliAccessToken(database, rotated.access_token, ["reports:read"]),
      (error) => error instanceof McpAccessTokenError && error.code === "invalid_token",
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("connected-app revocation is tenant-bound and rejects the next JWT-backed request", async () => {
  const { auth, database, directory } = await fixture();
  try {
    registerTestClient(database);
    const cookie = await signUp(auth);
    const tokens = await issueTokens(auth, cookie);
    const claims = decodeJwt(tokens.access_token);
    const app = listConnectedMcpApps(database, claims.sub).at(0);
    assert.ok(app);
    assert.equal(revokeConnectedMcpApp(database, "another-user", app.consentId), false);
    const beforeRevocation = authorizeMcpClaims(database, claims, ["reports:read"]);
    assert.equal(beforeRevocation.ok, true, JSON.stringify(beforeRevocation));
    assert.equal(revokeConnectedMcpApp(database, claims.sub, app.consentId), true);
    assert.deepEqual(authorizeMcpClaims(database, claims, ["reports:read"]), { ok: false, reason: "missing_consent" });
    await assert.rejects(
      () => verifyMcpAccessToken(database, tokens.access_token),
      (error) => error instanceof McpAccessTokenError && error.code === "invalid_token",
    );
    assert.equal(database.prepare("SELECT count(*) AS total FROM oauthRefreshToken WHERE revoked IS NULL").get().total, 0);
    assert.equal(database.prepare("SELECT event_type FROM mcp_oauth_connection_events").get().event_type, "revoked_by_user");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("replaying a rotated refresh token revokes its family and the next MCP request", async () => {
  const { auth, database, directory } = await fixture();
  try {
    registerTestClient(database);
    const cookie = await signUp(auth);
    const first = await issueTokens(auth, cookie);
    const rotationResponse = await refreshGrant(auth, first.refresh_token);
    assert.equal(rotationResponse.status, 200, await rotationResponse.clone().text());
    const rotated = await rotationResponse.json();
    assert.notEqual(rotated.refresh_token, first.refresh_token);
    assert.equal(authorizeMcpClaims(database, decodeJwt(rotated.access_token), ["reports:read"]).ok, true);

    const replayResponse = await refreshGrant(auth, first.refresh_token);
    assert.equal(replayResponse.status, 400, await replayResponse.clone().text());
    assert.equal(database.prepare("SELECT count(*) AS total FROM oauthRefreshToken WHERE revoked IS NULL").get().total, 0);
    assert.deepEqual(
      authorizeMcpClaims(database, decodeJwt(rotated.access_token), ["reports:read"]),
      { ok: false, reason: "inactive_grant" },
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("consent and account UI disclose spend effects and unverified client identity", async () => {
  const [consent, account, oauthConfig, nextConfig, revokeRoute, task] = await Promise.all([
    readFile(new URL("../app/oauth/consent/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/account/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/mcp-oauth-shared.ts", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/connected-apps/[consentId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/tasks/2026-08-28-mcp-oauth.md", import.meta.url), "utf8"),
  ]);
  assert.match(oauthConfig, /consumes your plan's report quota/i);
  assert.match(oauthConfig, /consume monitoring credits/i);
  assert.match(consent, /self-asserted, unverified identity/i);
  assert.match(account, /CONNECTED APPS/);
  assert.match(account, /Revoke/);
  assert.match(account, /oauthResult\?\.redirect_uri \|\| oauthResult\?\.url/);
  assert.match(revokeRoute, /requestOrigin !== new URL\(request.url\)\.origin/);
  assert.match(nextConfig, /frame-ancestors 'none'/);
  assert.match(task, /standards conformance harness uses an explicitly pre-registered public test client/i);
  assert.match(task, /@better-auth\/mcp@1\.7\.2/);
});

test("the Vinext production bundle retains exact OAuth discovery rewrites and handlers", async () => {
  const [builtServer, nextConfig, task] = await Promise.all([
    readFile(new URL("../dist/server/index.js", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/tasks/2026-08-28-mcp-well-known-vinext.md", import.meta.url), "utf8"),
  ]);

  for (const route of [
    "/api/mcp/oauth-protected-resource",
    "/api/mcp/oauth-protected-resource/mcp",
    "/api/mcp/oauth-protected-resource/api",
    "/api/mcp/oauth-authorization-server",
  ]) {
    assert.match(builtServer, new RegExp(route.replaceAll("/", "\\/")));
  }
  for (const publicPath of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/api",
    "/.well-known/oauth-authorization-server",
  ]) {
    assert.match(nextConfig, new RegExp(publicPath.replaceAll("/", "\\/")));
  }
  assert.match(task, /Vinext 0\.0\.50 ignored\s+the dot-prefixed/i);
});
