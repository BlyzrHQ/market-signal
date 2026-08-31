import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { SignJWT } from "jose";

import { handleShopifyBootstrap } from "../app/api/shopify/bootstrap/route.ts";
import { ensureBillingSchema } from "../app/lib/billing-store.ts";
import {
  shopifyConfigFromEnvironment,
  ShopifyConfigurationError,
} from "../app/lib/shopify/config.ts";
import {
  ShopifyAuthenticationError,
  verifyShopifyIdToken,
} from "../app/lib/shopify/id-token.ts";
import {
  canonicalShopifyShop,
  ShopifyShopDomainError,
  shopifyShopFromUrlClaim,
} from "../app/lib/shopify/shop-domain.ts";
import {
  ensureShopifySchema,
  processShopifyWebhook,
  resolveShopifyActor,
  saveShopifyInstallation,
  ShopifyStoreError,
} from "../app/lib/shopify/store.ts";
import {
  decryptShopifyToken,
  encryptShopifyToken,
  ShopifyTokenCryptoError,
} from "../app/lib/shopify/token-crypto.ts";
import {
  exchangeShopifyOfflineToken,
  ShopifyTokenExchangeError,
} from "../app/lib/shopify/token-exchange.ts";
import {
  ShopifyWebhookError,
  verifyShopifyWebhookRequest,
} from "../app/lib/shopify/webhooks.ts";
import { shopifyAppHomeResponse } from "../app/shopify/route.ts";

const NOW = new Date("2026-08-31T01:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const CLIENT_ID = "market-signal-shopify-client";
const CLIENT_SECRET = "shopify-test-secret-that-is-longer-than-thirty-two-characters";
const ACTIVE_KEY = Buffer.alloc(32, 7);

function environment(databasePath = join(tmpdir(), "market-signal-shopify.sqlite")) {
  return {
    MARKET_SIGNAL_SHOPIFY_APP: "true",
    MARKET_SIGNAL_DEPLOY_TARGET: "node",
    MARKET_SIGNAL_SQLITE_PATH: databasePath,
    SHOPIFY_CLIENT_ID: CLIENT_ID,
    SHOPIFY_CLIENT_SECRET: CLIENT_SECRET,
    SHOPIFY_API_VERSION: "2026-07",
    SHOPIFY_TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: "v1",
    SHOPIFY_TOKEN_ENCRYPTION_KEYS_JSON: JSON.stringify({ v1: ACTIVE_KEY.toString("base64") }),
  };
}

function config(databasePath) {
  return shopifyConfigFromEnvironment(environment(databasePath));
}

function memoryDatabase() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  ensureShopifySchema(database);
  database.exec(`
    CREATE TABLE report_runs (id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL DEFAULT '');
    CREATE TABLE report_matches (id text PRIMARY KEY NOT NULL);
  `);
  ensureBillingSchema(database);
  return database;
}

function tokenInput(scopes = ["read_products"]) {
  return {
    accessTokenCiphertext: '{"v":1,"protected":"offline"}',
    accessTokenExpiresAt: "2026-09-30T01:00:00.000Z",
    refreshTokenCiphertext: '{"v":1,"protected":"refresh"}',
    refreshTokenExpiresAt: "2027-08-31T01:00:00.000Z",
    scopes,
    tokenKeyVersion: "v1",
  };
}

function install(database, shop = "north-star.myshopify.com", staffSubject = "123456789") {
  return saveShopifyInstallation(database, {
    now: NOW,
    requiredScopes: ["read_products"],
    shop,
    staffSubject,
    tokens: tokenInput(),
  });
}

async function signedIdToken(overrides = {}) {
  const shop = overrides.shop || "north-star.myshopify.com";
  const algorithm = overrides.algorithm || "HS256";
  const secret = overrides.secret || CLIENT_SECRET;
  const payload = {
    dest: overrides.dest ?? `https://${shop}`,
    sub: overrides.sub ?? "123456789",
  };
  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: algorithm })
    .setIssuer(overrides.issuer ?? `https://${shop}/admin`)
    .setAudience(overrides.audience ?? CLIENT_ID)
    .setIssuedAt(NOW_SECONDS);
  if (!overrides.omitNbf) builder = builder.setNotBefore(overrides.notBefore ?? NOW_SECONDS - 1);
  if (!overrides.omitExpiration) builder = builder.setExpirationTime(overrides.expiration ?? NOW_SECONDS + 60);
  return builder.sign(new TextEncoder().encode(secret));
}

function webhookRequest({
  body = JSON.stringify({ shop_domain: "north-star.myshopify.com" }),
  deliveryId = "delivery-1",
  secret = CLIENT_SECRET,
  shop = "north-star.myshopify.com",
  topic = "app/uninstalled",
} = {}) {
  const signature = createHmac("sha256", secret).update(body, "utf8").digest("base64");
  return new Request("https://signal.blyzr.com/api/shopify/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": signature,
      "x-shopify-shop-domain": shop,
      "x-shopify-topic": topic,
      "x-shopify-webhook-id": deliveryId,
    },
    body,
  });
}

test("Shopify configuration is explicit, versioned, and fail closed", () => {
  const valid = environment("C:\\data\\market-signal.sqlite");
  const parsed = shopifyConfigFromEnvironment(valid);
  assert.equal(parsed.clientId, CLIENT_ID);
  assert.equal(parsed.encryptionKeys.get("v1").byteLength, 32);
  assert.deepEqual(parsed.requiredScopes, ["read_products"]);
  for (const changed of [
    { ...valid, MARKET_SIGNAL_SHOPIFY_APP: "false" },
    { ...valid, MARKET_SIGNAL_DEPLOY_TARGET: "cloudflare" },
    { ...valid, MARKET_SIGNAL_SQLITE_PATH: "relative.sqlite" },
    { ...valid, SHOPIFY_CLIENT_ID: "" },
    { ...valid, SHOPIFY_CLIENT_SECRET: "short" },
    { ...valid, SHOPIFY_API_VERSION: "latest" },
    { ...valid, SHOPIFY_TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION: "v2" },
    { ...valid, SHOPIFY_TOKEN_ENCRYPTION_KEYS_JSON: JSON.stringify({ v1: Buffer.alloc(31).toString("base64") }) },
    { ...valid, SHOPIFY_TOKEN_ENCRYPTION_KEYS_JSON: "not-json" },
  ]) {
    assert.throws(() => shopifyConfigFromEnvironment(changed), ShopifyConfigurationError);
  }
});

test("Shopify shop canonicalization accepts only one strict myshopify label", () => {
  assert.equal(canonicalShopifyShop("  North-Star.MyShopify.com  "), "north-star.myshopify.com");
  assert.equal(shopifyShopFromUrlClaim("https://north-star.myshopify.com/admin"), "north-star.myshopify.com");
  for (const value of [
    "https://north-star.myshopify.com",
    "north-star.myshopify.com:443",
    "north-star.myshopify.com/path",
    "north-star.myshopify.com?shop=other",
    "north-star.myshopify.com.evil.test",
    "nested.north-star.myshopify.com",
    "myshopify.com",
    "-north.myshopify.com",
    "north-.myshopify.com",
    "nørth.myshopify.com",
    "127.0.0.1",
  ]) assert.throws(() => canonicalShopifyShop(value), ShopifyShopDomainError);
  for (const value of [
    "http://north-star.myshopify.com",
    "https://user@north-star.myshopify.com",
    "https://north-star.myshopify.com:444/admin",
    "https://north-star.myshopify.com/admin?x=1",
  ]) assert.throws(() => shopifyShopFromUrlClaim(value), ShopifyShopDomainError);
});

test("Shopify ID tokens verify signature, time, audience, subject, issuer, and destination", async () => {
  const verified = await verifyShopifyIdToken(await signedIdToken(), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, NOW);
  assert.deepEqual(verified, {
    expiresAt: NOW_SECONDS + 60,
    issuedAt: NOW_SECONDS,
    shop: "north-star.myshopify.com",
    staffSubject: "123456789",
  });
  const invalid = [
    signedIdToken({ audience: "another-app" }),
    signedIdToken({ secret: "another-secret-that-is-definitely-longer-than-thirty-two-characters" }),
    signedIdToken({ algorithm: "HS512" }),
    signedIdToken({ expiration: NOW_SECONDS - 10 }),
    signedIdToken({ notBefore: NOW_SECONDS + 10 }),
    signedIdToken({ omitNbf: true }),
    signedIdToken({ omitExpiration: true }),
    signedIdToken({ sub: "staff@example.test" }),
    signedIdToken({ issuer: "https://other-shop.myshopify.com/admin" }),
    signedIdToken({ dest: "https://north-star.myshopify.com.evil.test" }),
  ];
  for (const promise of invalid) {
    const token = await promise;
    await assert.rejects(
      verifyShopifyIdToken(token, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, NOW),
      ShopifyAuthenticationError,
    );
  }
  const expired = await signedIdToken({ expiration: NOW_SECONDS - 10 });
  await assert.rejects(
    verifyShopifyIdToken(expired, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, NOW),
    (error) => error instanceof ShopifyAuthenticationError && error.retryWithFreshToken,
  );
});

test("Shopify token encryption is randomized, installation-bound, purpose-bound, and tamper evident", () => {
  const cryptoConfig = {
    encryptionActiveKeyVersion: "v1",
    encryptionKeys: new Map([["v1", ACTIVE_KEY], ["old", Buffer.alloc(32, 3)]]),
  };
  const plaintext = "shpat_test_offline_token_123456789";
  const first = encryptShopifyToken(plaintext, "north-star.myshopify.com", "offline-access", cryptoConfig);
  const second = encryptShopifyToken(plaintext, "north-star.myshopify.com", "offline-access", cryptoConfig);
  assert.notEqual(first, second);
  assert.equal(decryptShopifyToken(first, "north-star.myshopify.com", "offline-access", cryptoConfig), plaintext);
  assert.ok(!first.includes(plaintext));
  assert.throws(() => decryptShopifyToken(first, "other-shop.myshopify.com", "offline-access", cryptoConfig), ShopifyTokenCryptoError);
  assert.throws(() => decryptShopifyToken(first, "north-star.myshopify.com", "refresh", cryptoConfig), ShopifyTokenCryptoError);
  const tampered = JSON.parse(first);
  tampered.c = `${tampered.c.slice(0, -1)}${tampered.c.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptShopifyToken(JSON.stringify(tampered), "north-star.myshopify.com", "offline-access", cryptoConfig), ShopifyTokenCryptoError);
  assert.throws(() => decryptShopifyToken(first, "north-star.myshopify.com", "offline-access", { encryptionKeys: new Map() }), ShopifyTokenCryptoError);
});

test("offline token exchange sends Shopify's exact bounded token-exchange form", async () => {
  let observed;
  const result = await exchangeShopifyOfflineToken({
    config: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenExchangeTimeoutMs: 1_000 },
    idToken: "id-token-longer-than-sixteen-characters",
    now: NOW,
    shop: "north-star.myshopify.com",
  }, async (url, init) => {
    observed = { url, init };
    return new Response(JSON.stringify({
      access_token: "offline-access-token-long-enough",
      expires_in: 3600,
      refresh_token: "refresh-token-value-long-enough",
      refresh_token_expires_in: 7200,
      scope: "read_products,read_locales",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(observed.url, "https://north-star.myshopify.com/admin/oauth/access_token");
  assert.equal(observed.init.method, "POST");
  const form = observed.init.body;
  assert.equal(form.get("client_id"), CLIENT_ID);
  assert.equal(form.get("client_secret"), CLIENT_SECRET);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(form.get("subject_token_type"), "urn:ietf:params:oauth:token-type:id_token");
  assert.equal(form.get("requested_token_type"), "urn:shopify:params:oauth:token-type:offline-access-token");
  assert.equal(form.get("expiring"), "1");
  assert.deepEqual(result, {
    accessToken: "offline-access-token-long-enough",
    accessTokenExpiresAt: "2026-08-31T02:00:00.000Z",
    refreshToken: "refresh-token-value-long-enough",
    refreshTokenExpiresAt: "2026-08-31T03:00:00.000Z",
    scopes: ["read_locales", "read_products"],
  });
});

test("offline token exchange maps stale and malformed upstream responses without leaking bodies", async () => {
  const input = {
    config: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokenExchangeTimeoutMs: 1_000 },
    idToken: "id-token-longer-than-sixteen-characters",
    shop: "north-star.myshopify.com",
  };
  await assert.rejects(
    exchangeShopifyOfflineToken(input, async () => new Response("sensitive Shopify detail", { status: 400 })),
    (error) => error instanceof ShopifyTokenExchangeError && error.code === "stale-session" && !error.message.includes("sensitive"),
  );
  await assert.rejects(
    exchangeShopifyOfflineToken(input, async () => new Response('{"access_token":"short"}', { status: 200 })),
    (error) => error instanceof ShopifyTokenExchangeError && error.code === "shopify-unavailable",
  );
  await assert.rejects(
    exchangeShopifyOfflineToken(input, async () => new Response("x".repeat(65_537), { status: 200 })),
    (error) => error instanceof ShopifyTokenExchangeError && error.code === "shopify-unavailable",
  );
});

test("installation creates one Shopify workspace and noncredential staff actors without spending", () => {
  const database = memoryDatabase();
  try {
    const first = install(database);
    const repeated = install(database);
    const secondStaff = install(database, "north-star.myshopify.com", "987654321");
    assert.equal(first.created, true);
    assert.equal(repeated.created, false);
    assert.equal(secondStaff.workspaceId, first.workspaceId);
    assert.equal(database.prepare(`SELECT count(*) AS total FROM workspaces`).get().total, 1);
    assert.equal(database.prepare(`SELECT count(*) AS total FROM shopify_installations`).get().total, 1);
    assert.equal(database.prepare(`SELECT count(*) AS total FROM workspace_members`).get().total, 2);
    assert.equal(database.prepare(`SELECT count(*) AS total FROM billing_report_reservations`).get().total, 0);
    assert.equal(database.prepare(`SELECT count(*) AS total FROM price_watchers`).get().total, 0);
    assert.equal(database.prepare(`SELECT count(*) AS total FROM price_watch_credit_reservations`).get().total, 0);
    const principals = database.prepare(`
      SELECT users.email, users.emailVerified, accounts.password, accounts.accessToken, accounts.refreshToken
      FROM "user" users JOIN "account" accounts ON accounts.userId = users.id
      WHERE accounts.providerId = 'shopify'
    `).all();
    assert.equal(principals.length, 2);
    assert.ok(principals.every((row) => row.email.endsWith(".invalid") && row.emailVerified === 0));
    assert.ok(principals.every((row) => row.password === null && row.accessToken === null && row.refreshToken === null));
  } finally {
    database.close();
  }
});

test("Shopify actor resolution is shop-bound and the same staff subject does not cross tenants", () => {
  const database = memoryDatabase();
  try {
    const first = install(database, "north-star.myshopify.com", "123456789");
    const other = install(database, "south-star.myshopify.com", "123456789");
    assert.notEqual(first.workspaceId, other.workspaceId);
    assert.notEqual(first.userId, other.userId);
    assert.equal(resolveShopifyActor(database, {
      now: NOW,
      requiredScopes: ["read_products"],
      shop: "north-star.myshopify.com",
      staffSubject: "123456789",
    }).workspaceId, first.workspaceId);
    assert.throws(() => resolveShopifyActor(database, {
      now: NOW,
      requiredScopes: ["read_products"],
      shop: "unknown-shop.myshopify.com",
      staffSubject: "123456789",
    }), (error) => error instanceof ShopifyStoreError && error.code === "not-found");
  } finally {
    database.close();
  }
});

test("Shopify workspaces are structurally rejected by Stripe subscription storage", () => {
  const database = memoryDatabase();
  try {
    const installed = install(database);
    assert.throws(() => database.prepare(`
      INSERT INTO workspace_subscriptions (
        workspace_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan_tier,
        status, cancel_at_period_end, current_period_start, current_period_end,
        last_event_created, last_event_id, updated_at
      ) VALUES (?, 'cus_shopify', '', '', '', 'incomplete', 0, '', '', 0, '', ?)
    `).run(installed.workspaceId, NOW.toISOString()), /Shopify workspaces cannot use Stripe subscriptions/);
    database.prepare(`
      INSERT INTO workspaces (id, name, slug, kind, personal_owner_user_id, created_at, updated_at)
      VALUES ('stripe-workspace', 'Stripe workspace', 'stripe-workspace', 'personal', NULL, ?, ?)
    `).run(NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO workspace_subscriptions (workspace_id, stripe_customer_id, updated_at)
      VALUES ('stripe-workspace', 'cus_personal', ?)
    `).run(NOW.toISOString());
    assert.throws(
      () => database.prepare(`UPDATE workspaces SET kind = 'shopify' WHERE id = 'stripe-workspace'`).run(),
      /Stripe subscription workspaces cannot become Shopify workspaces/,
    );
  } finally {
    database.close();
  }
});

test("uninstall atomically deletes usable tokens, disables watchers, releases reservations, and is replay safe", () => {
  const database = memoryDatabase();
  try {
    const installed = install(database);
    database.prepare(`
      INSERT INTO price_watchers (
        id, workspace_id, canonical_url, canonicalization_version, source_domain, rival_domain,
        product_name, variant_key, variant_json, audit_target, cadence, state, created_at, updated_at
      ) VALUES ('watcher-1', ?, 'https://rival.test/item', 1, 'north-star.myshopify.com',
        'rival.test', 'Item', 'default', '{}', 'audit-1', 'daily', 'active', ?, ?)
    `).run(installed.workspaceId, NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO price_watch_credit_reservations (
        id, workspace_id, watcher_id, period_start, period_end, due_slot, status, created_at, updated_at
      ) VALUES ('reservation-1', ?, 'watcher-1', '2026-08-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z', 'daily:1', 'reserved', ?, ?)
    `).run(installed.workspaceId, NOW.toISOString(), NOW.toISOString());
    const event = {
      deliveryId: "delivery-uninstall",
      payloadHash: "a".repeat(64),
      payload: { shop_domain: "north-star.myshopify.com" },
      shop: "north-star.myshopify.com",
      topic: "app/uninstalled",
    };
    assert.deepEqual(processShopifyWebhook(database, event, ["read_products"], NOW), { duplicate: false, result: "uninstalled" });
    const installation = database.prepare(`
      SELECT offline_token_ciphertext, refresh_token_ciphertext, install_state, redaction_state
      FROM shopify_installations
    `).get();
    assert.deepEqual(installation, {
      offline_token_ciphertext: "",
      refresh_token_ciphertext: "",
      install_state: "uninstalled",
      redaction_state: "pending",
    });
    assert.deepEqual(database.prepare(`SELECT state, pause_reason FROM price_watchers`).get(), {
      state: "disabled",
      pause_reason: "shopify-uninstalled",
    });
    assert.equal(database.prepare(`SELECT status FROM price_watch_credit_reservations`).get().status, "released");
    assert.deepEqual(processShopifyWebhook(database, event, ["read_products"], NOW), { duplicate: true, result: "uninstalled" });
    assert.throws(() => processShopifyWebhook(database, { ...event, shop: "other-shop.myshopify.com" }, ["read_products"], NOW),
      (error) => error instanceof ShopifyStoreError && error.code === "delivery-conflict");
  } finally {
    database.close();
  }
});

test("scope updates fail closed and final redaction makes a later install fresh", () => {
  const database = memoryDatabase();
  try {
    const installed = install(database);
    const scopes = processShopifyWebhook(database, {
      deliveryId: "delivery-scopes",
      payloadHash: "b".repeat(64),
      payload: { current: ["read_orders"] },
      shop: "north-star.myshopify.com",
      topic: "app/scopes_update",
    }, ["read_products"], NOW);
    assert.equal(scopes.result, "scopes-blocked");
    assert.equal(resolveShopifyActor(database, {
      now: NOW,
      requiredScopes: ["read_products"],
      shop: "north-star.myshopify.com",
      staffSubject: "123456789",
    }).requiredScopesGranted, false);
    assert.throws(() => processShopifyWebhook(database, {
      deliveryId: "delivery-invalid-scopes",
      payloadHash: "c".repeat(64),
      payload: { current: "read_products" },
      shop: "north-star.myshopify.com",
      topic: "app/scopes_update",
    }, ["read_products"], NOW), (error) => error instanceof ShopifyStoreError && error.code === "invalid-payload");

    const redacted = processShopifyWebhook(database, {
      deliveryId: "delivery-redact",
      payloadHash: "d".repeat(64),
      payload: { shop_domain: "north-star.myshopify.com" },
      shop: "north-star.myshopify.com",
      topic: "shop/redact",
    }, ["read_products"], NOW);
    assert.equal(redacted.result, "redacted");
    assert.equal(database.prepare(`SELECT count(*) AS total FROM shopify_installations`).get().total, 0);
    assert.equal(database.prepare(`SELECT count(*) AS total FROM workspaces`).get().total, 0);
    assert.equal(database.prepare(`SELECT count(*) AS total FROM "account" WHERE providerId = 'shopify'`).get().total, 0);
    assert.equal(database.prepare(`SELECT count(*) AS total FROM shopify_webhook_deliveries`).get().total, 0);
    const redactionRetry = processShopifyWebhook(database, {
      deliveryId: "delivery-redact-retry",
      payloadHash: "f".repeat(64),
      payload: { shop_domain: "north-star.myshopify.com" },
      shop: "north-star.myshopify.com",
      topic: "shop/redact",
    }, ["read_products"], NOW);
    assert.equal(redactionRetry.result, "redaction-noop");
    assert.equal(database.prepare(`SELECT count(*) AS total FROM shopify_webhook_deliveries`).get().total, 0);
    const fresh = install(database);
    assert.notEqual(fresh.workspaceId, installed.workspaceId);
    assert.equal(fresh.created, true);
  } finally {
    database.close();
  }
});

test("privacy webhook receipts retain no raw customer fields", () => {
  const database = memoryDatabase();
  try {
    install(database);
    const email = "private-customer@example.test";
    processShopifyWebhook(database, {
      deliveryId: "delivery-customer-redact",
      payloadHash: "e".repeat(64),
      payload: { shop_domain: "north-star.myshopify.com", customer: { email } },
      shop: "north-star.myshopify.com",
      topic: "customers/redact",
    }, ["read_products"], NOW);
    const rows = database.prepare(`SELECT * FROM shopify_webhook_deliveries`).all();
    assert.ok(!JSON.stringify(rows).includes(email));
    assert.equal(rows[0].result_code, "no-customer-data-stored");
  } finally {
    database.close();
  }
});

test("Shopify webhook verification authenticates the untouched raw body before parsing", async () => {
  const body = JSON.stringify({ shop_domain: "north-star.myshopify.com", note: "exact bytes" });
  const verified = await verifyShopifyWebhookRequest(webhookRequest({ body }), CLIENT_SECRET);
  assert.equal(verified.shop, "north-star.myshopify.com");
  assert.equal(verified.topic, "app/uninstalled");
  assert.equal(verified.payload.note, "exact bytes");

  await assert.rejects(
    verifyShopifyWebhookRequest(webhookRequest({ body, secret: "wrong-secret-value-that-is-long-enough" }), CLIENT_SECRET),
    (error) => error instanceof ShopifyWebhookError && error.httpStatus === 401,
  );
  await assert.rejects(
    verifyShopifyWebhookRequest(webhookRequest({ body: JSON.stringify({ shop_domain: "other-shop.myshopify.com" }) }), CLIENT_SECRET),
    (error) => error instanceof ShopifyWebhookError && error.httpStatus === 400,
  );
  await assert.rejects(
    verifyShopifyWebhookRequest(webhookRequest({ topic: "products/update" }), CLIENT_SECRET),
    (error) => error instanceof ShopifyWebhookError && error.httpStatus === 404,
  );
  await assert.rejects(
    verifyShopifyWebhookRequest(webhookRequest({ body: "x".repeat(1_048_577) }), CLIENT_SECRET),
    (error) => error instanceof ShopifyWebhookError && error.httpStatus === 400,
  );
});

test("the embedded shell is dynamically framed only by Shopify and contains no merchant data", async () => {
  const response = shopifyAppHomeResponse(
    new Request("https://signal.blyzr.com/shopify?shop=North-Star.MyShopify.com"),
    environment("C:\\data\\market-signal.sqlite"),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors https:\/\/admin\.shopify\.com https:\/\/north-star\.myshopify\.com/);
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const html = await response.text();
  assert.match(html, /cdn\.shopify\.com\/shopifycloud\/app-bridge\.js/);
  assert.match(html, /api\/shopify\/bootstrap/);
  assert.ok(!html.includes(CLIENT_SECRET));
  assert.ok(!html.includes("north-star.myshopify.com"));

  const invalid = shopifyAppHomeResponse(
    new Request("https://signal.blyzr.com/shopify?shop=example.com"),
    environment("C:\\data\\market-signal.sqlite"),
  );
  assert.equal(invalid.status, 400);
});

test("an unconfigured bootstrap fails before verification, exchange, or storage", async () => {
  let touched = 0;
  const response = await handleShopifyBootstrap(new Request("https://signal.blyzr.com/api/shopify/bootstrap", { method: "POST" }), {
    config: () => { throw new ShopifyConfigurationError(); },
    verifyIdToken: async () => { touched += 1; throw new Error("should not run"); },
    exchangeToken: async () => { touched += 1; throw new Error("should not run"); },
    openDatabase: async () => { touched += 1; throw new Error("should not run"); },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "shopify_not_configured");
  assert.equal(touched, 0);
});

test("bootstrap asks App Bridge for one fresh retry when token exchange reports a stale session", async () => {
  const response = await handleShopifyBootstrap(new Request("https://signal.blyzr.com/api/shopify/bootstrap", {
    method: "POST",
    headers: { authorization: "Bearer a-valid-looking-id-token" },
  }), {
    config: () => config("C:\\data\\market-signal.sqlite"),
    verifyIdToken: async () => ({
      expiresAt: NOW_SECONDS + 60,
      issuedAt: NOW_SECONDS,
      shop: "north-star.myshopify.com",
      staffSubject: "123456789",
    }),
    exchangeToken: async () => { throw new ShopifyTokenExchangeError("stale-session"); },
    openDatabase: async () => { throw new Error("should not run"); },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-shopify-retry-invalid-session-request"), "1");
  assert.equal((await response.json()).code, "shopify_session_stale");
});

test("encrypted Shopify tokens are not present in the SQLite database file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "market-signal-shopify-token-"));
  const databasePath = join(directory, "market-signal.sqlite");
  const database = new Database(databasePath);
  const plaintext = "shpat_plaintext_must_not_appear_123456789";
  try {
    database.pragma("foreign_keys = ON");
    ensureShopifySchema(database);
    const cryptoConfig = config(databasePath);
    saveShopifyInstallation(database, {
      now: NOW,
      requiredScopes: ["read_products"],
      shop: "north-star.myshopify.com",
      staffSubject: "123456789",
      tokens: {
        accessTokenCiphertext: encryptShopifyToken(plaintext, "north-star.myshopify.com", "offline-access", cryptoConfig),
        accessTokenExpiresAt: "2026-09-30T01:00:00.000Z",
        refreshTokenCiphertext: "",
        refreshTokenExpiresAt: "",
        scopes: ["read_products"],
        tokenKeyVersion: "v1",
      },
    });
  } finally {
    database.close();
  }
  try {
    const bytes = await readFile(databasePath);
    assert.equal(bytes.includes(Buffer.from(plaintext, "utf8")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
