import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { ensureAccountSchema } from "../account-auth.ts";
import { canonicalNodeSqlitePath } from "../node-sqlite-database.ts";
import { disableWorkspacePriceWatchers } from "../price-watch-store.ts";
import { canonicalShopifyShop, shopifyIssuer } from "./shop-domain.ts";

export type ShopifyInstallState = "active" | "scope_blocked" | "uninstalled";

export type ShopifyActorContext = {
  installState: ShopifyInstallState;
  requiredScopesGranted: boolean;
  scopes: string[];
  shop: string;
  userId: string;
  workspaceId: string;
};

export type ShopifyBootstrapRecord = ShopifyActorContext & {
  created: boolean;
  reconnected: boolean;
};

export type ShopifyEncryptedTokenInput = {
  accessTokenCiphertext: string;
  accessTokenExpiresAt: string;
  refreshTokenCiphertext: string;
  refreshTokenExpiresAt: string;
  scopes: string[];
  tokenKeyVersion: string;
};

export type ShopifyWebhookTopic =
  | "app/uninstalled"
  | "app/scopes_update"
  | "customers/data_request"
  | "customers/redact"
  | "shop/redact";

export type ShopifyWebhookEvent = {
  deliveryId: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  shop: string;
  topic: ShopifyWebhookTopic;
};

export class ShopifyStoreError extends Error {
  readonly code: "invalid-payload" | "not-found" | "delivery-conflict" | "redaction-extension-required" | "storage-unavailable";
  readonly httpStatus: 400 | 404 | 409 | 503;

  constructor(code: ShopifyStoreError["code"], httpStatus: ShopifyStoreError["httpStatus"]) {
    super(code === "not-found" ? "The Shopify installation was not found." : "Shopify storage is unavailable.");
    this.name = "ShopifyStoreError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasTable(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(table));
}

function normalizedScopes(scopes: string[]): string[] {
  const normalized = scopes.map((scope) => String(scope || "").trim()).filter(Boolean);
  if (normalized.length > 100 || normalized.some((scope) => !/^[a-z][a-z0-9_]{0,79}$/.test(scope))) {
    throw new ShopifyStoreError("storage-unavailable", 503);
  }
  return [...new Set(normalized)].sort();
}

function parsedScopes(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? normalizedScopes(parsed.map(String)) : [];
  } catch {
    return [];
  }
}

function installationState(scopes: string[], requiredScopes: readonly string[]): ShopifyInstallState {
  return requiredScopes.every((scope) => scopes.includes(scope)) ? "active" : "scope_blocked";
}

function deterministicIdentity(shop: string, staffSubject: string) {
  const actorDigest = digest(`shopify-actor|${shop}|${staffSubject}`);
  return {
    userId: `shp-user-${actorDigest.slice(0, 32)}`,
    accountId: `shp-account-${actorDigest.slice(0, 32)}`,
    email: `shopify-${actorDigest}@principals.market-signal.invalid`,
  };
}

function ensureShopifyActor(
  database: Database.Database,
  shop: string,
  staffSubject: string,
  workspaceId: string,
  nowIso: string,
): string {
  const identity = deterministicIdentity(shop, staffSubject);
  database.prepare(`
    INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt)
    VALUES (?, ?, ?, 0, NULL, ?, ?)
  `).run(identity.userId, "Shopify staff", identity.email, nowIso, nowIso);
  const user = database.prepare(`SELECT id, email, emailVerified FROM "user" WHERE id = ? LIMIT 1`).get(identity.userId) as
    { id?: string; email?: string; emailVerified?: number } | undefined;
  if (!user || user.email !== identity.email || Number(user.emailVerified) !== 0) {
    throw new ShopifyStoreError("storage-unavailable", 503);
  }

  const issuer = shopifyIssuer(shop);
  database.prepare(`
    INSERT OR IGNORE INTO "account" (
      id, accountId, providerId, issuer, userId, accessToken, refreshToken, idToken,
      accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt
    ) VALUES (?, ?, 'shopify', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `).run(identity.accountId, staffSubject, issuer, identity.userId, nowIso, nowIso);
  const account = database.prepare(`
    SELECT userId, password FROM "account" WHERE issuer = ? AND accountId = ? LIMIT 1
  `).get(issuer, staffSubject) as { userId?: string; password?: string | null } | undefined;
  if (!account || account.userId !== identity.userId || account.password != null) {
    throw new ShopifyStoreError("storage-unavailable", 503);
  }
  database.prepare(`
    INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
    VALUES (?, ?, 'member', ?)
  `).run(workspaceId, identity.userId, nowIso);
  return identity.userId;
}

export function ensureShopifySchema(database: Database.Database): void {
  ensureAccountSchema(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS shopify_installations (
      shop_domain text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
      shop_gid text NOT NULL DEFAULT '',
      offline_token_ciphertext text NOT NULL DEFAULT '',
      refresh_token_ciphertext text NOT NULL DEFAULT '',
      offline_token_expires_at text NOT NULL DEFAULT '',
      refresh_token_expires_at text NOT NULL DEFAULT '',
      token_key_version text NOT NULL DEFAULT '',
      granted_scopes_json text NOT NULL DEFAULT '[]',
      install_state text NOT NULL CHECK(install_state IN ('active','scope_blocked','uninstalled')),
      redaction_state text NOT NULL CHECK(redaction_state IN ('active','pending')),
      primary_storefront_url text NOT NULL DEFAULT '',
      storefront_state text NOT NULL DEFAULT 'not_checked',
      installed_at text NOT NULL,
      reinstalled_at text NOT NULL DEFAULT '',
      uninstalled_at text NOT NULL DEFAULT '',
      updated_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shopify_installations_state_idx
      ON shopify_installations(install_state, updated_at);

    CREATE TABLE IF NOT EXISTS shopify_webhook_deliveries (
      delivery_id text PRIMARY KEY NOT NULL,
      shop_domain text NOT NULL,
      topic text NOT NULL,
      payload_hash text NOT NULL,
      result_code text NOT NULL,
      processed_at text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shopify_webhook_deliveries_processed_idx
      ON shopify_webhook_deliveries(processed_at);
  `);
}

export async function openShopifyDatabase(databasePath: string): Promise<Database.Database> {
  let database: Database.Database | null = null;
  try {
    const canonicalPath = await canonicalNodeSqlitePath(databasePath);
    database = new Database(canonicalPath);
    database.pragma("busy_timeout = 10000");
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    ensureShopifySchema(database);
    return database;
  } catch {
    database?.close();
    throw new ShopifyStoreError("storage-unavailable", 503);
  }
}

export function saveShopifyInstallation(
  database: Database.Database,
  input: {
    now?: Date;
    requiredScopes: readonly string[];
    shop: string;
    staffSubject: string;
    tokens: ShopifyEncryptedTokenInput;
  },
): ShopifyBootstrapRecord {
  const shop = canonicalShopifyShop(input.shop);
  const scopes = normalizedScopes(input.tokens.scopes);
  const nowIso = (input.now || new Date()).toISOString();
  const execute = database.transaction(() => {
    const existing = database.prepare(`SELECT * FROM shopify_installations WHERE shop_domain = ? LIMIT 1`).get(shop) as
      Record<string, unknown> | undefined;
    const created = !existing;
    const reconnected = Boolean(existing && existing.install_state === "uninstalled");
    const workspaceId = existing ? String(existing.workspace_id) : randomUUID();
    if (!existing) {
      const label = shop.slice(0, -".myshopify.com".length);
      const workspaceSlug = `shopify-${label.slice(0, 35)}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      database.prepare(`
        INSERT INTO workspaces (id, name, slug, kind, personal_owner_user_id, created_at, updated_at)
        VALUES (?, ?, ?, 'shopify', NULL, ?, ?)
      `).run(workspaceId, shop, workspaceSlug, nowIso, nowIso);
    } else {
      const workspace = database.prepare(`SELECT kind FROM workspaces WHERE id = ? LIMIT 1`).get(workspaceId) as { kind?: string } | undefined;
      if (!workspace || workspace.kind !== "shopify") throw new ShopifyStoreError("storage-unavailable", 503);
    }
    const userId = ensureShopifyActor(database, shop, input.staffSubject, workspaceId, nowIso);
    const state = installationState(scopes, input.requiredScopes);
    if (!existing) {
      database.prepare(`
        INSERT INTO shopify_installations (
          shop_domain, workspace_id, offline_token_ciphertext, refresh_token_ciphertext,
          offline_token_expires_at, refresh_token_expires_at, token_key_version,
          granted_scopes_json, install_state, redaction_state, installed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        shop,
        workspaceId,
        input.tokens.accessTokenCiphertext,
        input.tokens.refreshTokenCiphertext,
        input.tokens.accessTokenExpiresAt,
        input.tokens.refreshTokenExpiresAt,
        input.tokens.tokenKeyVersion,
        JSON.stringify(scopes),
        state,
        nowIso,
        nowIso,
      );
    } else {
      database.prepare(`
        UPDATE shopify_installations
        SET offline_token_ciphertext = ?, refresh_token_ciphertext = ?, offline_token_expires_at = ?,
            refresh_token_expires_at = ?, token_key_version = ?, granted_scopes_json = ?, install_state = ?,
            redaction_state = 'active', reinstalled_at = CASE WHEN install_state = 'uninstalled' THEN ? ELSE reinstalled_at END,
            uninstalled_at = '', updated_at = ?
        WHERE shop_domain = ?
      `).run(
        input.tokens.accessTokenCiphertext,
        input.tokens.refreshTokenCiphertext,
        input.tokens.accessTokenExpiresAt,
        input.tokens.refreshTokenExpiresAt,
        input.tokens.tokenKeyVersion,
        JSON.stringify(scopes),
        state,
        nowIso,
        nowIso,
        shop,
      );
    }
    return {
      created,
      reconnected,
      installState: state,
      requiredScopesGranted: state === "active",
      scopes,
      shop,
      userId,
      workspaceId,
    } satisfies ShopifyBootstrapRecord;
  });
  return execute.immediate();
}

export function resolveShopifyActor(
  database: Database.Database,
  input: { now?: Date; requiredScopes: readonly string[]; shop: string; staffSubject: string },
): ShopifyActorContext {
  const shop = canonicalShopifyShop(input.shop);
  const execute = database.transaction(() => {
    const installation = database.prepare(`
      SELECT workspace_id, granted_scopes_json, install_state
      FROM shopify_installations WHERE shop_domain = ? LIMIT 1
    `).get(shop) as Record<string, unknown> | undefined;
    if (!installation || !["active", "scope_blocked"].includes(String(installation.install_state))) {
      throw new ShopifyStoreError("not-found", 404);
    }
    const workspaceId = String(installation.workspace_id);
    const scopes = parsedScopes(installation.granted_scopes_json);
    const userId = ensureShopifyActor(
      database,
      shop,
      input.staffSubject,
      workspaceId,
      (input.now || new Date()).toISOString(),
    );
    return {
      installState: String(installation.install_state) as ShopifyInstallState,
      requiredScopesGranted: input.requiredScopes.every((scope) => scopes.includes(scope)),
      scopes,
      shop,
      userId,
      workspaceId,
    } satisfies ShopifyActorContext;
  });
  return execute.immediate();
}

function redactShopifyFoundation(database: Database.Database, shop: string): string {
  const installation = database.prepare(`SELECT workspace_id FROM shopify_installations WHERE shop_domain = ? LIMIT 1`).get(shop) as
    { workspace_id?: string } | undefined;
  if (!installation?.workspace_id) {
    database.prepare(`DELETE FROM shopify_webhook_deliveries WHERE shop_domain = ?`).run(shop);
    return "redaction-noop";
  }
  const workspaceId = installation.workspace_id;
  if (hasTable(database, "report_runs")) {
    const reports = database.prepare(`SELECT count(*) AS total FROM report_runs WHERE workspace_id = ?`).get(workspaceId) as { total?: number };
    if (Number(reports.total || 0) > 0) throw new ShopifyStoreError("redaction-extension-required", 503);
  }
  disableWorkspacePriceWatchers(database, workspaceId, "shopify-shop-redacted");
  const issuer = shopifyIssuer(shop);
  const users = database.prepare(`SELECT userId FROM "account" WHERE issuer = ?`).all(issuer) as Array<{ userId: string }>;
  database.prepare(`DELETE FROM shopify_webhook_deliveries WHERE shop_domain = ?`).run(shop);
  database.prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspaceId);
  database.prepare(`DELETE FROM "account" WHERE issuer = ?`).run(issuer);
  for (const { userId } of users) {
    database.prepare(`
      DELETE FROM "user" WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM "account" WHERE userId = ?)
        AND NOT EXISTS (SELECT 1 FROM "session" WHERE userId = ?)
        AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE user_id = ?)
    `).run(userId, userId, userId, userId);
  }
  return "redacted";
}

function scopesFromWebhook(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.current)) throw new ShopifyStoreError("invalid-payload", 400);
  const scopes = payload.current.map((scope) => String(scope || "").trim()).filter(Boolean);
  if (scopes.length > 100 || scopes.some((scope) => !/^[a-z][a-z0-9_]{0,79}$/.test(scope))) {
    throw new ShopifyStoreError("invalid-payload", 400);
  }
  return [...new Set(scopes)].sort();
}

export function processShopifyWebhook(
  database: Database.Database,
  event: ShopifyWebhookEvent,
  requiredScopes: readonly string[],
  now = new Date(),
): { duplicate: boolean; result: string } {
  const shop = canonicalShopifyShop(event.shop);
  const nowIso = now.toISOString();
  const execute = database.transaction(() => {
    const existing = database.prepare(`SELECT shop_domain, topic, payload_hash, result_code FROM shopify_webhook_deliveries WHERE delivery_id = ? LIMIT 1`)
      .get(event.deliveryId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.shop_domain !== shop || existing.topic !== event.topic || existing.payload_hash !== event.payloadHash) {
        throw new ShopifyStoreError("delivery-conflict", 409);
      }
      return { duplicate: true, result: String(existing.result_code) };
    }

    database.prepare(`
      INSERT INTO shopify_webhook_deliveries (delivery_id, shop_domain, topic, payload_hash, result_code, processed_at)
      VALUES (?, ?, ?, ?, 'processing', ?)
    `).run(event.deliveryId, shop, event.topic, event.payloadHash, nowIso);

    let result = "acknowledged";
    if (event.topic === "app/uninstalled") {
      const installation = database.prepare(`SELECT workspace_id FROM shopify_installations WHERE shop_domain = ? LIMIT 1`).get(shop) as
        { workspace_id?: string } | undefined;
      if (installation?.workspace_id) {
        disableWorkspacePriceWatchers(database, installation.workspace_id, "shopify-uninstalled", now);
        database.prepare(`
          UPDATE shopify_installations
          SET offline_token_ciphertext = '', refresh_token_ciphertext = '', offline_token_expires_at = '',
              refresh_token_expires_at = '', token_key_version = '', install_state = 'uninstalled',
              redaction_state = 'pending', uninstalled_at = ?, updated_at = ?
          WHERE shop_domain = ?
        `).run(nowIso, nowIso, shop);
        result = "uninstalled";
      } else result = "uninstall-noop";
    } else if (event.topic === "app/scopes_update") {
      const scopes = scopesFromWebhook(event.payload);
      const state = installationState(scopes, requiredScopes);
      const updated = database.prepare(`
        UPDATE shopify_installations
        SET granted_scopes_json = ?, install_state = CASE WHEN install_state = 'uninstalled' THEN install_state ELSE ? END,
            updated_at = ?
        WHERE shop_domain = ?
      `).run(JSON.stringify(scopes), state, nowIso, shop).changes;
      result = updated ? (state === "active" ? "scopes-healthy" : "scopes-blocked") : "scopes-noop";
    } else if (event.topic === "shop/redact") {
      result = redactShopifyFoundation(database, shop);
    } else {
      result = "no-customer-data-stored";
    }

    database.prepare(`UPDATE shopify_webhook_deliveries SET result_code = ?, processed_at = ? WHERE delivery_id = ?`)
      .run(result, nowIso, event.deliveryId);
    return { duplicate: false, result };
  });
  return execute.immediate();
}
