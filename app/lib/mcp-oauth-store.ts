import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { JWTPayload } from "jose";
import { ensurePersonalWorkspace } from "./account-auth.ts";
import {
  CLI_AUTHORIZATION_SCOPES,
  CLI_CLIENT_ID,
  CLI_RESOURCE,
  MCP_AUTHORIZATION_SCOPES,
  MCP_RESOURCE,
  MCP_RESOURCE_SCOPES,
  mcpClientIdentity,
  normalizeMcpScopes,
  type McpResourceScope,
} from "./mcp-oauth-shared.ts";
import { ensureMcpOAuthSchema } from "./mcp-oauth-schema.ts";
import { canonicalNodeSqlitePath } from "./node-sqlite-database.ts";

const BUSY_TIMEOUT_MS = 10_000;

type OAuthConsentRow = {
  id: string;
  clientId: string;
  resources: string | null;
  scopes: string;
  createdAt: string | number | null;
  updatedAt: string | number | null;
  clientName: string | null;
  clientUri: string | null;
  clientDiscoveryId: string | null;
};

type RefreshTokenRow = {
  resources: string | null;
  scopes: string;
  expiresAt: string | number;
};

export type ConnectedMcpApp = ReturnType<typeof connectedAppFromRows>;

export type McpAuthorizationContext = {
  clientId: string;
  scopes: string[];
  user: { id: string; name: string; email: string };
  workspaceId: string;
};

export type McpAuthorizationResult =
  | { ok: true; context: McpAuthorizationContext }
  | { ok: false; reason: "invalid_claims" | "inactive_client" | "inactive_session" | "missing_consent" | "inactive_grant" | "insufficient_scope" };

export async function openMcpOAuthDatabase(
  environment: Record<string, string | undefined> = process.env,
): Promise<Database.Database> {
  const configuredPath = String(environment.MARKET_SIGNAL_SQLITE_PATH || "").trim();
  const path = await canonicalNodeSqlitePath(configuredPath);
  const database = new Database(path);
  database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  ensureMcpOAuthSchema(database);
  return database;
}

function parseDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : null;
  const date = numeric === null ? new Date(value) : new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric);
  return Number.isFinite(date.getTime()) ? date : null;
}

function includesEvery(haystack: string[], needles: readonly string[]) {
  const available = new Set(haystack);
  return needles.every((needle) => available.has(needle));
}

function hasResource(value: unknown, resource: string) {
  return normalizeMcpScopes(value).includes(resource);
}

function connectedAppFromRows(consent: OAuthConsentRow, refreshTokens: RefreshTokenRow[], now: Date) {
  const scopes = normalizeMcpScopes(consent.scopes);
  const resources = normalizeMcpScopes(consent.resources);
  const activeGrant = refreshTokens.some((token) => {
    const expiresAt = parseDate(token.expiresAt);
    return Boolean(
      expiresAt &&
      expiresAt > now &&
      resources.length > 0 &&
      includesEvery(normalizeMcpScopes(token.resources), resources) &&
      includesEvery(normalizeMcpScopes(token.scopes), scopes),
    );
  });
  return {
    consentId: consent.id,
    client: mcpClientIdentity(consent.clientId, consent.clientName),
    clientUri: consent.clientUri,
    discovery: consent.clientDiscoveryId || "pre-registered",
    scopes,
    resources,
    connectedAt: parseDate(consent.createdAt)?.toISOString() || "",
    updatedAt: parseDate(consent.updatedAt)?.toISOString() || "",
    status: activeGrant ? "active" as const : "reauthorization_required" as const,
  };
}

export function listConnectedMcpApps(
  database: Database.Database,
  userId: string,
  now = new Date(),
) {
  const consents = database.prepare(`
    SELECT
      consent.id,
      consent.clientId,
      consent.resources,
      consent.scopes,
      consent.createdAt,
      consent.updatedAt,
      client.name AS clientName,
      client.uri AS clientUri,
      client.clientDiscoveryId
    FROM oauthConsent AS consent
    JOIN oauthClient AS client ON client.clientId = consent.clientId
    WHERE consent.userId = ? AND coalesce(client.disabled, 0) = 0
    ORDER BY consent.updatedAt DESC, consent.id DESC
  `).all(userId) as OAuthConsentRow[];

  return consents.map((consent) => {
    const refreshTokens = database.prepare(`
      SELECT resources, scopes, expiresAt
      FROM oauthRefreshToken
      WHERE userId = ? AND clientId = ? AND revoked IS NULL
        AND (clientId = ? OR sessionId IS NOT NULL)
    `).all(userId, consent.clientId, CLI_CLIENT_ID) as RefreshTokenRow[];
    return connectedAppFromRows(consent, refreshTokens, now);
  });
}

export function listRecentMcpConnectionEvents(database: Database.Database, userId: string) {
  return database.prepare(`
    SELECT client_id AS clientId, event_type AS eventType, details_json AS detailsJson, created_at AS createdAt
    FROM mcp_oauth_connection_events
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 10
  `).all(userId).map((row) => {
    const event = row as { clientId: string; eventType: string; detailsJson: string; createdAt: string };
    return {
      client: mcpClientIdentity(event.clientId),
      eventType: event.eventType,
      createdAt: event.createdAt,
    };
  });
}

export function revokeConnectedMcpApp(
  database: Database.Database,
  userId: string,
  consentId: string,
  now = new Date(),
) {
  const revoke = database.transaction(() => {
    const consent = database.prepare(`
      SELECT id, clientId
      FROM oauthConsent
      WHERE id = ? AND userId = ?
    `).get(consentId, userId) as { id: string; clientId: string } | undefined;
    if (!consent) return false;
    const revokedAt = now.toISOString();
    database.prepare(`
      UPDATE oauthRefreshToken
      SET revoked = coalesce(revoked, ?)
      WHERE userId = ? AND clientId = ?
    `).run(revokedAt, userId, consent.clientId);
    database.prepare(`
      DELETE FROM oauthAccessToken
      WHERE userId = ? AND clientId = ?
    `).run(userId, consent.clientId);
    database.prepare(`
      DELETE FROM oauthConsent
      WHERE userId = ? AND clientId = ?
    `).run(userId, consent.clientId);
    database.prepare(`
      INSERT INTO mcp_oauth_connection_events
        (id, user_id, client_id, event_type, details_json, created_at)
      VALUES (?, ?, ?, 'revoked_by_user', '{}', ?)
    `).run(randomUUID(), userId, consent.clientId, revokedAt);
    return true;
  });
  return revoke.immediate();
}

export function authorizeMcpClaims(
  database: Database.Database,
  claims: JWTPayload,
  requiredScopes: readonly McpResourceScope[] = [],
  now = new Date(),
): McpAuthorizationResult {
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const clientId = typeof claims.client_id === "string"
    ? claims.client_id
    : typeof claims.azp === "string" ? claims.azp : "";
  const sessionId = typeof claims.sid === "string" ? claims.sid : "";
  const jti = typeof claims.jti === "string" ? claims.jti : "";
  const scopes = normalizeMcpScopes(claims.scope);
  if (!userId || !clientId || !sessionId || !jti || claims.aud !== MCP_RESOURCE) {
    return { ok: false, reason: "invalid_claims" };
  }
  if (!includesEvery(scopes, ["offline_access", ...requiredScopes]) || !scopes.every((scope) => MCP_AUTHORIZATION_SCOPES.includes(scope as never))) {
    return { ok: false, reason: "insufficient_scope" };
  }

  const client = database.prepare(`
    SELECT clientId, disabled, requirePKCE, tokenEndpointAuthMethod
    FROM oauthClient
    WHERE clientId = ?
  `).get(clientId) as { clientId: string; disabled: number | null; requirePKCE: number | null; tokenEndpointAuthMethod: string | null } | undefined;
  const linked = database.prepare(`
    SELECT 1 AS linked
    FROM oauthClientResource
    WHERE clientId = ? AND resourceId = ?
  `).get(clientId, MCP_RESOURCE);
  if (!client || client.disabled || client.requirePKCE === 0 || client.tokenEndpointAuthMethod !== "none" || !linked) {
    return { ok: false, reason: "inactive_client" };
  }

  const session = database.prepare(`
    SELECT session.userId, session.expiresAt, user.name, user.email
    FROM session
    JOIN user ON user.id = session.userId
    WHERE session.id = ? AND session.userId = ?
  `).get(sessionId, userId) as { userId: string; expiresAt: string | number; name: string; email: string } | undefined;
  const sessionExpiry = parseDate(session?.expiresAt);
  if (!session || !sessionExpiry || sessionExpiry <= now) return { ok: false, reason: "inactive_session" };

  const consentRows = database.prepare(`
    SELECT id, resources, scopes
    FROM oauthConsent
    WHERE userId = ? AND clientId = ?
  `).all(userId, clientId) as Array<{ id: string; resources: string | null; scopes: string }>;
  const consent = consentRows.find((candidate) =>
    hasResource(candidate.resources, MCP_RESOURCE) && includesEvery(normalizeMcpScopes(candidate.scopes), scopes),
  );
  if (!consent) return { ok: false, reason: "missing_consent" };

  const refreshTokens = database.prepare(`
    SELECT resources, scopes, expiresAt
    FROM oauthRefreshToken
    WHERE userId = ? AND clientId = ? AND sessionId = ? AND revoked IS NULL
  `).all(userId, clientId, sessionId) as RefreshTokenRow[];
  const activeGrant = refreshTokens.some((token) => {
    const expiresAt = parseDate(token.expiresAt);
    return Boolean(
      expiresAt &&
      expiresAt > now &&
      hasResource(token.resources, MCP_RESOURCE) &&
      includesEvery(normalizeMcpScopes(token.scopes), scopes),
    );
  });
  if (!activeGrant) return { ok: false, reason: "inactive_grant" };

  const workspaceId = ensurePersonalWorkspace(database, { id: userId, name: session.name || "Personal" });
  return {
    ok: true,
    context: {
      clientId,
      scopes,
      user: { id: userId, name: session.name || "", email: session.email },
      workspaceId,
    },
  };
}

export function authorizeCliClaims(
  database: Database.Database,
  claims: JWTPayload,
  requiredScopes: readonly ("reports:read" | "reports:create")[] = [],
  now = new Date(),
): McpAuthorizationResult {
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const clientId = typeof claims.client_id === "string"
    ? claims.client_id
    : typeof claims.azp === "string" ? claims.azp : "";
  const jti = typeof claims.jti === "string" ? claims.jti : "";
  const scopes = normalizeMcpScopes(claims.scope);
  if (!userId || clientId !== CLI_CLIENT_ID || !jti || claims.aud !== CLI_RESOURCE) {
    return { ok: false, reason: "invalid_claims" };
  }
  if (!includesEvery(scopes, ["offline_access", ...requiredScopes]) || !scopes.every((scope) => CLI_AUTHORIZATION_SCOPES.includes(scope as never))) {
    return { ok: false, reason: "insufficient_scope" };
  }

  const client = database.prepare(`
    SELECT clientId, disabled, requirePKCE, tokenEndpointAuthMethod
    FROM oauthClient
    WHERE clientId = ?
  `).get(clientId) as { clientId: string; disabled: number | null; requirePKCE: number | null; tokenEndpointAuthMethod: string | null } | undefined;
  const linked = database.prepare(`
    SELECT 1 AS linked
    FROM oauthClientResource
    WHERE clientId = ? AND resourceId = ?
  `).get(clientId, CLI_RESOURCE);
  if (!client || client.disabled || client.requirePKCE === 0 || client.tokenEndpointAuthMethod !== "none" || !linked) {
    return { ok: false, reason: "inactive_client" };
  }

  const user = database.prepare(`SELECT id, name, email FROM user WHERE id = ?`).get(userId) as { id: string; name: string; email: string } | undefined;
  if (!user) return { ok: false, reason: "inactive_session" };

  const consentRows = database.prepare(`
    SELECT id, resources, scopes
    FROM oauthConsent
    WHERE userId = ? AND clientId = ?
  `).all(userId, clientId) as Array<{ id: string; resources: string | null; scopes: string }>;
  const consent = consentRows.find((candidate) =>
    hasResource(candidate.resources, CLI_RESOURCE) && includesEvery(normalizeMcpScopes(candidate.scopes), scopes),
  );
  if (!consent) return { ok: false, reason: "missing_consent" };

  const refreshTokens = database.prepare(`
    SELECT resources, scopes, expiresAt
    FROM oauthRefreshToken
    WHERE userId = ? AND clientId = ? AND revoked IS NULL
  `).all(userId, clientId) as RefreshTokenRow[];
  const activeGrant = refreshTokens.some((token) => {
    const expiresAt = parseDate(token.expiresAt);
    return Boolean(
      expiresAt &&
      expiresAt > now &&
      hasResource(token.resources, CLI_RESOURCE) &&
      includesEvery(normalizeMcpScopes(token.scopes), scopes),
    );
  });
  if (!activeGrant) return { ok: false, reason: "inactive_grant" };

  const workspaceId = ensurePersonalWorkspace(database, { id: userId, name: user.name || "Personal" });
  return {
    ok: true,
    context: {
      clientId,
      scopes,
      user: { id: userId, name: user.name || "", email: user.email },
      workspaceId,
    },
  };
}

export function supportedMcpScope(value: string): value is McpResourceScope {
  return MCP_RESOURCE_SCOPES.includes(value as McpResourceScope);
}
