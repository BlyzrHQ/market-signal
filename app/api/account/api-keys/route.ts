import { accountAuthConfigFromEnvironment, accountContext, type AccountContext } from "../../../lib/account-auth.ts";
import { openMcpOAuthDatabase } from "../../../lib/mcp-oauth-store.ts";
import { mutationRequestIsSameOrigin, readBoundedJsonObject } from "../../../lib/request-json.ts";
import {
  createReportApiKey,
  listReportApiKeys,
  ReportApiKeyStoreError,
} from "../../../lib/report-api-keys.ts";

const NO_STORE = { "cache-control": "no-store, max-age=0" };

type ApiKeyRouteServices = {
  enabled: () => boolean;
  authorize: (request: Request) => Promise<AccountContext | null>;
  openDatabase: typeof openMcpOAuthDatabase;
};

export function apiKeyRouteServices(): ApiKeyRouteServices {
  return {
    enabled: () => Boolean(accountAuthConfigFromEnvironment(process.env)?.mcpEnabled),
    authorize: accountContext,
    openDatabase: openMcpOAuthDatabase,
  };
}

function routeError(error: unknown) {
  if (error instanceof ReportApiKeyStoreError) {
    const status = error.code.startsWith("invalid-") ? 400 : error.code === "active-key-limit" ? 409 : 403;
    return Response.json({ ok: false, error: error.message, errorCode: error.code }, { status, headers: NO_STORE });
  }
  console.error("Report API key request failed.", { errorCode: "report-api-key-request-failed" });
  return Response.json({ ok: false, error: "API key management is temporarily unavailable.", errorCode: "storage-unavailable" }, { status: 503, headers: NO_STORE });
}

export async function getReportApiKeys(request: Request, services: ApiKeyRouteServices = apiKeyRouteServices()) {
  try {
    if (!services.enabled()) return new Response(null, { status: 404, headers: NO_STORE });
    const account = await services.authorize(request);
    if (!account) return Response.json({ ok: false, error: "Sign in to manage API keys.", errorCode: "authentication-required" }, { status: 401, headers: NO_STORE });
    const database = await services.openDatabase();
    try {
      return Response.json({ ok: true, keys: listReportApiKeys(database, { userId: account.user.id, workspaceId: account.workspaceId }) }, { headers: NO_STORE });
    } finally {
      database.close();
    }
  } catch (error) {
    return routeError(error);
  }
}

export async function createReportApiKeyRoute(request: Request, services: ApiKeyRouteServices = apiKeyRouteServices()) {
  try {
    if (!services.enabled()) return new Response(null, { status: 404, headers: NO_STORE });
    if (!mutationRequestIsSameOrigin(request)) return Response.json({ ok: false, error: "Invalid request origin.", errorCode: "invalid-origin" }, { status: 403, headers: NO_STORE });
    const account = await services.authorize(request);
    if (!account) return Response.json({ ok: false, error: "Sign in to create an API key.", errorCode: "authentication-required" }, { status: 401, headers: NO_STORE });
    let body: Record<string, unknown>;
    try {
      body = await readBoundedJsonObject(request, 2_048);
    } catch {
      return Response.json({ ok: false, error: "Invalid or oversized JSON body.", errorCode: "invalid-json" }, { status: 400, headers: NO_STORE });
    }
    const database = await services.openDatabase();
    try {
      const created = createReportApiKey(
        database,
        { userId: account.user.id, workspaceId: account.workspaceId },
        body.name,
        { access: body.access, expiresInDays: body.expiresInDays },
      );
      return Response.json({ ok: true, ...created }, { status: 201, headers: NO_STORE });
    } finally {
      database.close();
    }
  } catch (error) {
    return routeError(error);
  }
}

export async function GET(request: Request) {
  return getReportApiKeys(request);
}

export async function POST(request: Request) {
  return createReportApiKeyRoute(request);
}
