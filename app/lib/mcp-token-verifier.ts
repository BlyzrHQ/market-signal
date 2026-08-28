import type Database from "better-sqlite3";
import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  MCP_CLOCK_TOLERANCE_SECONDS,
  MARKET_SIGNAL_ORIGIN,
  MCP_RESOURCE,
  MCP_RESOURCE_SCOPES,
} from "./mcp-oauth-shared.ts";
import { authorizeMcpClaims } from "./mcp-oauth-store.ts";

const JWKS_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1_000;

type JwksRow = {
  id: string;
  publicKey: string;
  expiresAt: string | number | null;
  alg: string | null;
  crv: string | null;
};

export type McpPrincipal = {
  workspaceId: string;
  userId: string;
  clientId: string;
};

export class McpAccessTokenError extends Error {
  readonly code: "invalid_token" | "insufficient_scope" | "authorization_unavailable";
  readonly status: 401 | 403 | 503;

  constructor(
    code: McpAccessTokenError["code"],
    message: string,
    status: McpAccessTokenError["status"],
  ) {
    super(message);
    this.name = "McpAccessTokenError";
    this.code = code;
    this.status = status;
  }
}

function parsedDate(value: string | number | null): Date | null {
  if (value === null || value === "") return null;
  const numeric = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : null;
  const date = numeric === null ? new Date(value) : new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric);
  return Number.isFinite(date.getTime()) ? date : null;
}

function publicKeySet(database: Database.Database, now: Date): JSONWebKeySet {
  let rows: JwksRow[];
  try {
    rows = database.prepare(`
      SELECT id, publicKey, expiresAt, alg, crv
      FROM jwks
      ORDER BY createdAt DESC, id DESC
    `).all() as JwksRow[];
  } catch {
    throw new McpAccessTokenError(
      "authorization_unavailable",
      "MCP authorization is temporarily unavailable.",
      503,
    );
  }

  const keys = rows.flatMap((row) => {
    const expiry = parsedDate(row.expiresAt);
    if (expiry && expiry.getTime() + JWKS_GRACE_PERIOD_MS <= now.getTime()) return [];
    try {
      const parsed = JSON.parse(row.publicKey) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.kty) return [];
      return [{
        ...parsed,
        kid: row.id,
        alg: row.alg || "EdDSA",
        ...(row.crv ? { crv: row.crv } : {}),
      }];
    } catch {
      return [];
    }
  });
  if (keys.length === 0) {
    throw new McpAccessTokenError(
      "authorization_unavailable",
      "MCP authorization is temporarily unavailable.",
      503,
    );
  }
  return { keys } as JSONWebKeySet;
}

function principal(authInfo: AuthInfo): McpPrincipal | null {
  const workspaceId = authInfo.extra?.workspaceId;
  const userId = authInfo.extra?.userId;
  return typeof workspaceId === "string" && workspaceId && typeof userId === "string" && userId && authInfo.clientId
    ? { workspaceId, userId, clientId: authInfo.clientId }
    : null;
}

export function mcpPrincipalFromAuthInfo(authInfo: AuthInfo | undefined): McpPrincipal | null {
  return authInfo ? principal(authInfo) : null;
}

export async function verifyMcpAccessToken(
  database: Database.Database,
  token: string,
  now = new Date(),
): Promise<AuthInfo> {
  if (!token || token.length > 16_384 || !Number.isFinite(now.getTime())) {
    throw new McpAccessTokenError("invalid_token", "The MCP access token is invalid.", 401);
  }

  let verified: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    const keySet = createLocalJWKSet(publicKeySet(database, now));
    verified = await jwtVerify(token, keySet, {
      algorithms: ["EdDSA"],
      issuer: MARKET_SIGNAL_ORIGIN,
      audience: MCP_RESOURCE,
      typ: "at+jwt",
      clockTolerance: MCP_CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
    });
  } catch (error) {
    if (error instanceof McpAccessTokenError) throw error;
    throw new McpAccessTokenError("invalid_token", "The MCP access token is invalid or expired.", 401);
  }

  const authorization = authorizeMcpClaims(database, verified.payload, [], now);
  if (authorization.ok === false) {
    const insufficient = authorization.reason === "insufficient_scope";
    throw new McpAccessTokenError(
      insufficient ? "insufficient_scope" : "invalid_token",
      insufficient ? "The MCP access token does not grant a supported scope." : "The MCP authorization is invalid or revoked.",
      insufficient ? 403 : 401,
    );
  }
  if (!authorization.context.scopes.some((scope) => MCP_RESOURCE_SCOPES.includes(scope as never))) {
    throw new McpAccessTokenError(
      "insufficient_scope",
      "The MCP access token does not grant a supported scope.",
      403,
    );
  }

  return {
    token,
    clientId: authorization.context.clientId,
    scopes: authorization.context.scopes,
    expiresAt: verified.payload.exp,
    resource: new URL(MCP_RESOURCE),
    extra: {
      workspaceId: authorization.context.workspaceId,
      userId: authorization.context.user.id,
    },
  };
}
