import { accountAuthConfigFromEnvironment, accountContext, type AccountContext } from "../../../../lib/account-auth.ts";
import { openMcpOAuthDatabase } from "../../../../lib/mcp-oauth-store.ts";
import { mutationRequestIsSameOrigin } from "../../../../lib/request-json.ts";
import { revokeReportApiKey } from "../../../../lib/report-api-keys.ts";

const NO_STORE = { "cache-control": "no-store, max-age=0" };

type ApiKeyRevokeServices = {
  enabled: () => boolean;
  authorize: (request: Request) => Promise<AccountContext | null>;
  openDatabase: typeof openMcpOAuthDatabase;
};

export async function revokeReportApiKeyRoute(
  request: Request,
  context: { params: Promise<{ keyId: string }> | { keyId: string } },
  services: ApiKeyRevokeServices = {
    enabled: () => Boolean(accountAuthConfigFromEnvironment(process.env)?.mcpEnabled),
    authorize: accountContext,
    openDatabase: openMcpOAuthDatabase,
  },
) {
  if (!services.enabled()) return new Response(null, { status: 404, headers: NO_STORE });
  if (!mutationRequestIsSameOrigin(request)) return Response.json({ ok: false, error: "Invalid request origin.", errorCode: "invalid-origin" }, { status: 403, headers: NO_STORE });
  const account = await services.authorize(request);
  if (!account) return Response.json({ ok: false, error: "Sign in to revoke an API key.", errorCode: "authentication-required" }, { status: 401, headers: NO_STORE });
  const { keyId } = await context.params;
  if (!/^[A-Za-z0-9_-]{16}$/.test(keyId)) return Response.json({ ok: false, error: "The API key reference is invalid.", errorCode: "invalid-key" }, { status: 400, headers: NO_STORE });
  let database: Awaited<ReturnType<typeof openMcpOAuthDatabase>> | undefined;
  try {
    database = await services.openDatabase();
    const revoked = revokeReportApiKey(database, { userId: account.user.id, workspaceId: account.workspaceId }, keyId);
    if (!revoked) return Response.json({ ok: false, error: "That API key is not available.", errorCode: "api-key-not-found" }, { status: 404, headers: NO_STORE });
    return Response.json({ ok: true, revoked: true }, { headers: NO_STORE });
  } catch {
    console.error("Report API key revocation failed.", { errorCode: "report-api-key-revoke-failed" });
    return Response.json({ ok: false, error: "API key management is temporarily unavailable.", errorCode: "storage-unavailable" }, { status: 503, headers: NO_STORE });
  } finally {
    database?.close();
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ keyId: string }> }) {
  return revokeReportApiKeyRoute(request, context);
}
