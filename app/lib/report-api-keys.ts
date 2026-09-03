import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export const REPORT_API_KEY_PREFIX = "msk_live";
export const REPORT_API_KEY_SCOPES = ["reports:read", "reports:create"] as const;
export const MAX_ACTIVE_REPORT_API_KEYS = 10;

export type ReportApiKeyScope = typeof REPORT_API_KEY_SCOPES[number];

export type ReportApiKeyMetadata = {
  id: string;
  name: string;
  lastFour: string;
  scopes: ReportApiKeyScope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
};

export type ReportApiKeyAuthorization = {
  keyId: string;
  clientId: string;
  scopes: ReportApiKeyScope[];
  user: { id: string; name: string; email: string };
  workspaceId: string;
};

export type ReportApiKeyAuthorizationResult =
  | { ok: true; context: ReportApiKeyAuthorization }
  | { ok: false; reason: "invalid_key" | "insufficient_scope" };

export class ReportApiKeyStoreError extends Error {
  readonly code: "invalid-name" | "invalid-access" | "invalid-expiry" | "active-key-limit" | "not-owner";

  constructor(code: ReportApiKeyStoreError["code"], message: string) {
    super(message);
    this.name = "ReportApiKeyStoreError";
    this.code = code;
  }
}

type ReportApiKeyRow = {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  secretHash: string;
  lastFour: string;
  scopes: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  userName?: string;
  userEmail?: string;
};

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const KEY_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const API_KEY_PATTERN = new RegExp(`^${REPORT_API_KEY_PREFIX}_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$`);

function hashSecret(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("base64url");
}

function parseScopes(value: string): ReportApiKeyScope[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const available = new Set(REPORT_API_KEY_SCOPES);
    return [...new Set(parsed.filter((scope): scope is ReportApiKeyScope =>
      typeof scope === "string" && available.has(scope as ReportApiKeyScope),
    ))];
  } catch {
    return [];
  }
}

function metadata(row: ReportApiKeyRow, now: Date): ReportApiKeyMetadata {
  const expiresAt = new Date(row.expiresAt);
  return {
    id: row.id,
    name: row.name,
    lastFour: row.lastFour,
    scopes: parseScopes(row.scopes),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    status: row.revokedAt ? "revoked" : !Number.isFinite(expiresAt.getTime()) || expiresAt <= now ? "expired" : "active",
  };
}

function validName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ReportApiKeyStoreError("invalid-name", "Use a key name between 1 and 60 characters.");
  }
  return name;
}

function ownerCanManage(database: Database.Database, userId: string, workspaceId: string) {
  return Boolean(database.prepare(`
    SELECT 1 AS allowed
    FROM workspace_members
    WHERE workspace_id = ? AND user_id = ? AND role = 'owner'
  `).get(workspaceId, userId));
}

export function looksLikeReportApiKey(value: string) {
  return value.startsWith(`${REPORT_API_KEY_PREFIX}_`);
}

export function createReportApiKey(
  database: Database.Database,
  owner: { userId: string; workspaceId: string },
  requestedName: unknown,
  options: { access?: unknown; expiresInDays?: unknown } = {},
  now = new Date(),
) {
  const name = validName(requestedName);
  const access = options.access === undefined ? "full" : options.access;
  if (access !== "full" && access !== "read") {
    throw new ReportApiKeyStoreError("invalid-access", "Choose read-only or create-and-read API key access.");
  }
  const expiresInDays = options.expiresInDays === undefined ? 90 : Number(options.expiresInDays);
  if (![30, 90, 365].includes(expiresInDays)) {
    throw new ReportApiKeyStoreError("invalid-expiry", "Choose a 30, 90, or 365 day API key expiry.");
  }
  const scopes: ReportApiKeyScope[] = access === "read" ? ["reports:read"] : [...REPORT_API_KEY_SCOPES];
  if (!ownerCanManage(database, owner.userId, owner.workspaceId)) {
    throw new ReportApiKeyStoreError("not-owner", "Only the workspace owner can create API keys.");
  }
  const id = randomBytes(12).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  if (!KEY_ID_PATTERN.test(id) || !KEY_SECRET_PATTERN.test(secret)) {
    throw new Error("The operating system returned an invalid random API key.");
  }
  const apiKey = `${REPORT_API_KEY_PREFIX}_${id}_${secret}`;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1_000).toISOString();
  const row: ReportApiKeyRow = {
    id,
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    name,
    secretHash: hashSecret(secret),
    lastFour: secret.slice(-4),
    scopes: JSON.stringify(scopes),
    createdAt,
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
  };
  database.transaction(() => {
    const active = database.prepare(`
      SELECT count(*) AS total
      FROM report_api_keys
      WHERE user_id = ? AND workspace_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(owner.userId, owner.workspaceId, createdAt) as { total: number };
    if (Number(active.total) >= MAX_ACTIVE_REPORT_API_KEYS) {
      throw new ReportApiKeyStoreError("active-key-limit", `Revoke an existing key before creating more than ${MAX_ACTIVE_REPORT_API_KEYS}.`);
    }
    database.prepare(`
      INSERT INTO report_api_keys (
        id, user_id, workspace_id, name, secret_hash, last_four, scopes,
        created_at, expires_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(row.id, row.userId, row.workspaceId, row.name, row.secretHash, row.lastFour, row.scopes, row.createdAt, row.expiresAt);
    database.prepare(`
      INSERT INTO report_api_key_events (id, key_id, user_id, workspace_id, event_type, created_at)
      VALUES (?, ?, ?, ?, 'created', ?)
    `).run(randomUUID(), row.id, row.userId, row.workspaceId, createdAt);
  }).immediate();
  return { apiKey, key: metadata(row, now) };
}

export function listReportApiKeys(
  database: Database.Database,
  owner: { userId: string; workspaceId: string },
  now = new Date(),
) {
  if (!ownerCanManage(database, owner.userId, owner.workspaceId)) return [];
  const rows = database.prepare(`
    SELECT
      id, user_id AS userId, workspace_id AS workspaceId, name,
      secret_hash AS secretHash, last_four AS lastFour, scopes,
      created_at AS createdAt, expires_at AS expiresAt,
      last_used_at AS lastUsedAt, revoked_at AS revokedAt
    FROM report_api_keys
    WHERE user_id = ? AND workspace_id = ?
    ORDER BY
      CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 0 ELSE 1 END,
      created_at DESC,
      id DESC
    LIMIT 50
  `).all(owner.userId, owner.workspaceId, now.toISOString()) as ReportApiKeyRow[];
  return rows.map((row) => metadata(row, now));
}

export function revokeReportApiKey(
  database: Database.Database,
  owner: { userId: string; workspaceId: string },
  keyId: string,
  now = new Date(),
) {
  if (!KEY_ID_PATTERN.test(keyId) || !ownerCanManage(database, owner.userId, owner.workspaceId)) return false;
  const revokedAt = now.toISOString();
  return database.transaction(() => {
    const result = database.prepare(`
      UPDATE report_api_keys
      SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND workspace_id = ? AND revoked_at IS NULL
    `).run(revokedAt, keyId, owner.userId, owner.workspaceId);
    if (result.changes !== 1) return false;
    database.prepare(`
      INSERT INTO report_api_key_events (id, key_id, user_id, workspace_id, event_type, created_at)
      VALUES (?, ?, ?, ?, 'revoked', ?)
    `).run(randomUUID(), keyId, owner.userId, owner.workspaceId, revokedAt);
    return true;
  }).immediate();
}

export function revokePresentedReportApiKey(
  database: Database.Database,
  value: string,
  now = new Date(),
) {
  const authorization = authorizeReportApiKey(database, value, [], now);
  if (!authorization.ok) return false;
  return revokeReportApiKey(database, {
    userId: authorization.context.user.id,
    workspaceId: authorization.context.workspaceId,
  }, authorization.context.keyId, now);
}

export function authorizeReportApiKey(
  database: Database.Database,
  value: string,
  requiredScopes: readonly ReportApiKeyScope[] = [],
  now = new Date(),
): ReportApiKeyAuthorizationResult {
  const match = API_KEY_PATTERN.exec(value);
  if (!match) return { ok: false, reason: "invalid_key" };
  const [, keyId, secret] = match;
  const row = database.prepare(`
    SELECT
      api_key.id, api_key.user_id AS userId, api_key.workspace_id AS workspaceId,
      api_key.name, api_key.secret_hash AS secretHash, api_key.last_four AS lastFour,
      api_key.scopes, api_key.created_at AS createdAt,
      api_key.expires_at AS expiresAt,
      api_key.last_used_at AS lastUsedAt, api_key.revoked_at AS revokedAt,
      user.name AS userName, user.email AS userEmail
    FROM report_api_keys AS api_key
    JOIN user ON user.id = api_key.user_id
    JOIN workspace_members AS member
      ON member.workspace_id = api_key.workspace_id AND member.user_id = api_key.user_id
    WHERE api_key.id = ? AND api_key.revoked_at IS NULL
  `).get(keyId) as ReportApiKeyRow | undefined;
  if (!row) return { ok: false, reason: "invalid_key" };

  const expected = Buffer.from(row.secretHash, "base64url");
  const actual = Buffer.from(hashSecret(secret), "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "invalid_key" };
  }
  const expiresAt = new Date(row.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    return { ok: false, reason: "invalid_key" };
  }
  const scopes = parseScopes(row.scopes);
  if (!requiredScopes.every((scope) => scopes.includes(scope))) {
    return { ok: false, reason: "insufficient_scope" };
  }

  const lastUsedAt = row.lastUsedAt ? new Date(row.lastUsedAt) : null;
  if (!lastUsedAt || !Number.isFinite(lastUsedAt.getTime()) || now.getTime() - lastUsedAt.getTime() >= 5 * 60 * 1_000) {
    database.prepare(`
      UPDATE report_api_keys SET last_used_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).run(now.toISOString(), keyId);
  }
  return {
    ok: true,
    context: {
      keyId,
      clientId: `report-api-key:${keyId}`,
      scopes,
      user: { id: row.userId, name: row.userName || "", email: row.userEmail || "" },
      workspaceId: row.workspaceId,
    },
  };
}
