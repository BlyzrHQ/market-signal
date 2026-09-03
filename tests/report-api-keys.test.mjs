import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAccountAuth, ensurePersonalWorkspace } from "../app/lib/account-auth.ts";
import { openMcpOAuthDatabase } from "../app/lib/mcp-oauth-store.ts";
import {
  authorizeReportApiKey,
  createReportApiKey,
  listReportApiKeys,
  ReportApiKeyStoreError,
  revokeReportApiKey,
} from "../app/lib/report-api-keys.ts";
import { ReportApiAuthorizationError, reportApiAccountContext } from "../app/lib/report-api-auth.ts";
import { createReportApiKeyRoute, getReportApiKeys } from "../app/api/account/api-keys/route.ts";
import { revokeReportApiKeyRoute } from "../app/api/account/api-keys/[keyId]/route.ts";
import { revokeCurrentReportApiKey } from "../app/api/cli/api-key/route.ts";

const ORIGIN = "https://signal.blyzr.com";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-report-api-keys-"));
  const databasePath = join(directory, "market-signal.sqlite");
  const environment = {
    MARKET_SIGNAL_DEPLOY_TARGET: "node",
    MARKET_SIGNAL_HOSTED_BILLING: "true",
    MARKET_SIGNAL_SQLITE_PATH: databasePath,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: "a-report-api-key-test-secret-with-more-than-thirty-two-characters",
    STRIPE_RESTRICTED_KEY: `rk_test_${"a".repeat(24)}`,
    STRIPE_WEBHOOK_SECRET: `whsec_${"b".repeat(24)}`,
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_SOLO: "price_solo",
    STRIPE_PRICE_GROWTH: "price_growth",
    STRIPE_PRICE_AGENCY: "price_agency",
  };
  const auth = await createAccountAuth({
    baseURL: ORIGIN,
    databasePath,
    mcpEnabled: true,
    secret: environment.BETTER_AUTH_SECRET,
  });
  await auth.$context;
  const signUp = await auth.handler(new Request(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ name: "API Key Owner", email: "keys@example.test", password: "secure-password-123" }),
  }));
  assert.equal(signUp.status, 200, await signUp.text());
  const cookie = signUp.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const user = auth.options.database.prepare(`SELECT id, name, email FROM user WHERE email = ?`).get("keys@example.test");
  const workspaceId = ensurePersonalWorkspace(auth.options.database, user);
  const account = { user, workspaceId };
  const openDatabase = () => openMcpOAuthDatabase(environment);
  return { account, auth, cookie, databasePath, directory, environment, openDatabase };
}

test("workspace API keys are one-time, hashed, scoped, expiring, and tenant-bound", async () => {
  const setup = await fixture();
  try {
    const now = new Date("2026-09-03T12:00:00.000Z");
    const created = createReportApiKey(
      setup.auth.options.database,
      { userId: setup.account.user.id, workspaceId: setup.account.workspaceId },
      "Research loop",
      { access: "full", expiresInDays: 90 },
      now,
    );
    assert.match(created.apiKey, /^msk_live_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(created.key.scopes, ["reports:read", "reports:create"]);
    assert.equal(created.key.expiresAt, "2026-12-02T12:00:00.000Z");

    const stored = setup.auth.options.database.prepare(`SELECT secret_hash, last_four, scopes FROM report_api_keys WHERE id = ?`).get(created.key.id);
    assert.equal(stored.secret_hash.length, 43);
    assert.equal(stored.last_four, created.apiKey.slice(-4));
    assert.equal(JSON.stringify(stored).includes(created.apiKey), false);
    assert.equal(listReportApiKeys(setup.auth.options.database, {
      userId: setup.account.user.id,
      workspaceId: setup.account.workspaceId,
    })[0].apiKey, undefined);

    const authorized = authorizeReportApiKey(setup.auth.options.database, created.apiKey, ["reports:create"], now);
    assert.equal(authorized.ok, true);
    assert.equal(authorized.ok && authorized.context.workspaceId, setup.account.workspaceId);
    const damaged = created.apiKey.slice(0, -1) + (created.apiKey.endsWith("a") ? "b" : "a");
    assert.deepEqual(authorizeReportApiKey(setup.auth.options.database, damaged, [], now), { ok: false, reason: "invalid_key" });
    assert.deepEqual(authorizeReportApiKey(setup.auth.options.database, created.apiKey, [], new Date(created.key.expiresAt)), { ok: false, reason: "invalid_key" });
    assert.equal(revokeReportApiKey(setup.auth.options.database, { userId: "another-user", workspaceId: setup.account.workspaceId }, created.key.id, now), false);
    assert.equal(revokeReportApiKey(setup.auth.options.database, { userId: setup.account.user.id, workspaceId: setup.account.workspaceId }, created.key.id, now), true);
    assert.deepEqual(authorizeReportApiKey(setup.auth.options.database, created.apiKey, [], now), { ok: false, reason: "invalid_key" });
    assert.deepEqual(
      setup.auth.options.database.prepare(`SELECT event_type FROM report_api_key_events WHERE key_id = ? ORDER BY created_at, rowid`).all(created.key.id).map((row) => row.event_type),
      ["created", "revoked"],
    );
    for (let index = 0; index < 10; index += 1) {
      createReportApiKey(setup.auth.options.database, {
        userId: setup.account.user.id,
        workspaceId: setup.account.workspaceId,
      }, `Agent ${index + 1}`, { access: "read", expiresInDays: 30 }, now);
    }
    assert.throws(
      () => createReportApiKey(setup.auth.options.database, {
        userId: setup.account.user.id,
        workspaceId: setup.account.workspaceId,
      }, "One too many", { access: "read", expiresInDays: 30 }, now),
      (error) => error instanceof ReportApiKeyStoreError && error.code === "active-key-limit",
    );
  } finally {
    setup.auth.options.database.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("hosted report authorization accepts a workspace key and keeps quota rate limits server-owned", async () => {
  const setup = await fixture();
  try {
    const created = createReportApiKey(setup.auth.options.database, {
      userId: setup.account.user.id,
      workspaceId: setup.account.workspaceId,
    }, "CLI", { access: "full", expiresInDays: 30 });
    const request = new Request(`${ORIGIN}/api/reports`, { method: "POST", headers: { authorization: `Bearer ${created.apiKey}` } });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const account = await reportApiAccountContext(request, setup.environment);
      assert.equal(account?.workspaceId, setup.account.workspaceId);
      assert.equal(account?.user.id, setup.account.user.id);
    }
    await assert.rejects(
      () => reportApiAccountContext(request, setup.environment),
      (error) => error instanceof ReportApiAuthorizationError && error.status === 429,
    );
  } finally {
    setup.auth.options.database.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("read-only keys cannot create reports but can read them", async () => {
  const setup = await fixture();
  try {
    const created = createReportApiKey(setup.auth.options.database, {
      userId: setup.account.user.id,
      workspaceId: setup.account.workspaceId,
    }, "Reader", { access: "read", expiresInDays: 30 });
    await assert.rejects(
      () => reportApiAccountContext(new Request(`${ORIGIN}/api/reports`, { method: "POST", headers: { authorization: `Bearer ${created.apiKey}` } }), setup.environment),
      (error) => error instanceof ReportApiAuthorizationError && error.status === 403 && error.errorCode === "insufficient-scope",
    );
    const account = await reportApiAccountContext(new Request(`${ORIGIN}/api/reports/report-id/result`, { headers: { authorization: `Bearer ${created.apiKey}` } }), setup.environment);
    assert.equal(account?.workspaceId, setup.account.workspaceId);
  } finally {
    setup.auth.options.database.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("session routes create, list, and revoke keys while rejecting cross-origin mutations", async () => {
  const setup = await fixture();
  const services = { enabled: () => true, authorize: async () => setup.account, openDatabase: setup.openDatabase };
  try {
    const rejected = await createReportApiKeyRoute(new Request(`${ORIGIN}/api/account/api-keys`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad" }),
    }), services);
    assert.equal(rejected.status, 403);

    const createdResponse = await createReportApiKeyRoute(new Request(`${ORIGIN}/api/account/api-keys`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Agent", access: "full", expiresInDays: 90 }),
    }), services);
    assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    assert.equal(createdResponse.headers.get("cache-control"), "no-store, max-age=0");
    const created = await createdResponse.json();
    assert.match(created.apiKey, /^msk_live_/);

    const listedResponse = await getReportApiKeys(new Request(`${ORIGIN}/api/account/api-keys`), services);
    const listed = await listedResponse.json();
    assert.equal(listed.keys.length, 1);
    assert.equal("apiKey" in listed.keys[0], false);
    assert.equal("secretHash" in listed.keys[0], false);

    const revokedResponse = await revokeReportApiKeyRoute(
      new Request(`${ORIGIN}/api/account/api-keys/${created.key.id}`, { method: "DELETE", headers: { origin: ORIGIN } }),
      { params: { keyId: created.key.id } },
      services,
    );
    assert.equal(revokedResponse.status, 200);
  } finally {
    setup.auth.options.database.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("a CLI can revoke only the exact API key it presents", async () => {
  const setup = await fixture();
  try {
    const created = createReportApiKey(setup.auth.options.database, {
      userId: setup.account.user.id,
      workspaceId: setup.account.workspaceId,
    }, "Temporary CLI", { access: "full", expiresInDays: 30 });
    const response = await revokeCurrentReportApiKey(new Request(`${ORIGIN}/api/cli/api-key`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${created.apiKey}` },
    }), { enabled: () => true, openDatabase: setup.openDatabase });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(authorizeReportApiKey(setup.auth.options.database, created.apiKey), { ok: false, reason: "invalid_key" });
    const replay = await revokeCurrentReportApiKey(new Request(`${ORIGIN}/api/cli/api-key`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${created.apiKey}` },
    }), { enabled: () => true, openDatabase: setup.openDatabase });
    assert.equal(replay.status, 401);
  } finally {
    setup.auth.options.database.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});
