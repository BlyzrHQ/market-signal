import type { AuthInfo, McpHttpHandler } from "@modelcontextprotocol/server";
import { hostedMcpEnabled } from "../lib/mcp-oauth-config.ts";
import { MARKET_SIGNAL_ORIGIN, MCP_RESOURCE_SCOPES } from "../lib/mcp-oauth-shared.ts";
import { openMcpOAuthDatabase } from "../lib/mcp-oauth-store.ts";
import { createMarketSignalMcpHandler } from "../lib/mcp-read-server.ts";
import { McpAccessTokenError, verifyMcpAccessToken } from "../lib/mcp-token-verifier.ts";
import { readBoundedJsonObject } from "../lib/request-json.ts";

const MAX_MCP_REQUEST_BYTES = 256 * 1_024;
const MCP_METADATA_URL = `${MARKET_SIGNAL_ORIGIN}/.well-known/oauth-protected-resource`;
const EXPECTED_HOST = new URL(MARKET_SIGNAL_ORIGIN).host;
const PRIVATE_MCP_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
  vary: "Authorization",
} as const;

const productionHandler = createMarketSignalMcpHandler();

export type McpRouteDependencies = {
  enabled: () => boolean;
  openDatabase: typeof openMcpOAuthDatabase;
  verify: typeof verifyMcpAccessToken;
  handler: McpHttpHandler;
};

export function mcpRouteDependencies(): McpRouteDependencies {
  return {
    enabled: () => hostedMcpEnabled(process.env, MARKET_SIGNAL_ORIGIN),
    openDatabase: openMcpOAuthDatabase,
    verify: verifyMcpAccessToken,
    handler: productionHandler,
  };
}

function withPrivateHeaders(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PRIVATE_MCP_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function bearerChallenge(error?: "invalid_token" | "insufficient_scope") {
  const parameters = [
    `resource_metadata="${MCP_METADATA_URL}"`,
    `scope="${MCP_RESOURCE_SCOPES.join(" ")}"`,
  ];
  if (error) parameters.push(`error="${error}"`);
  return `Bearer ${parameters.join(", ")}`;
}

function authenticationFailure(error?: McpAccessTokenError) {
  const status = error?.status || 401;
  const code = error?.code || "invalid_token";
  const headers = new Headers(PRIVATE_MCP_HEADERS);
  if (status !== 503) headers.set(
    "www-authenticate",
    bearerChallenge(code === "insufficient_scope" ? "insufficient_scope" : "invalid_token"),
  );
  return Response.json({
    error: code,
    error_description: error?.message || "A valid Market Signal MCP bearer token is required.",
  }, { status, headers });
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._~+\/-]+)$/i.exec(authorization);
  return match?.[1] || "";
}

function requestOriginIsAllowed(request: Request) {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  const host = request.headers.get("host") || url.host;
  if (host !== EXPECTED_HOST) return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === MARKET_SIGNAL_ORIGIN;
  } catch {
    return false;
  }
}

function contentTypeIsJson(request: Request) {
  return (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase() === "application/json";
}

export async function postMarketSignalMcp(
  request: Request,
  services: McpRouteDependencies = mcpRouteDependencies(),
) {
  if (!services.enabled()) return new Response(null, { status: 404, headers: PRIVATE_MCP_HEADERS });
  if (!requestOriginIsAllowed(request)) {
    return Response.json({ error: "invalid_request", error_description: "Invalid MCP request origin." }, { status: 403, headers: PRIVATE_MCP_HEADERS });
  }

  const token = bearerToken(request);
  if (!token) return authenticationFailure();

  let authInfo: AuthInfo;
  let database: Awaited<ReturnType<typeof openMcpOAuthDatabase>> | null = null;
  try {
    database = await services.openDatabase();
    authInfo = await services.verify(database, token);
  } catch (error) {
    if (error instanceof McpAccessTokenError) return authenticationFailure(error);
    console.error("Market Signal MCP authorization failed.", { errorCode: "mcp-authorization-failed" });
    return authenticationFailure(new McpAccessTokenError(
      "authorization_unavailable",
      "MCP authorization is temporarily unavailable.",
      503,
    ));
  } finally {
    database?.close();
  }

  if (!contentTypeIsJson(request)) {
    return Response.json({ error: "invalid_request", error_description: "MCP requests require application/json." }, { status: 415, headers: PRIVATE_MCP_HEADERS });
  }

  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = await readBoundedJsonObject(request.clone(), MAX_MCP_REQUEST_BYTES);
  } catch {
    return Response.json({ error: "invalid_request", error_description: "The MCP JSON request is invalid or too large." }, { status: 400, headers: PRIVATE_MCP_HEADERS });
  }

  try {
    return withPrivateHeaders(await services.handler.fetch(request, { authInfo, parsedBody }));
  } catch {
    console.error("Market Signal MCP request failed.", { errorCode: "mcp-request-failed" });
    return Response.json({ error: "server_error", error_description: "The MCP request could not be completed." }, { status: 500, headers: PRIVATE_MCP_HEADERS });
  }
}

export function nonPostMarketSignalMcp(services: Pick<McpRouteDependencies, "enabled"> = mcpRouteDependencies()) {
  if (!services.enabled()) return new Response(null, { status: 404, headers: PRIVATE_MCP_HEADERS });
  return Response.json({ error: "method_not_allowed", error_description: "Use POST for Market Signal MCP requests." }, {
    status: 405,
    headers: { ...PRIVATE_MCP_HEADERS, allow: "POST" },
  });
}

export async function POST(request: Request) {
  return postMarketSignalMcp(request);
}

export async function GET() { return nonPostMarketSignalMcp(); }
export async function HEAD() { return nonPostMarketSignalMcp(); }
export async function OPTIONS() { return nonPostMarketSignalMcp(); }
export async function PUT() { return nonPostMarketSignalMcp(); }
export async function PATCH() { return nonPostMarketSignalMcp(); }
export async function DELETE() { return nonPostMarketSignalMcp(); }
