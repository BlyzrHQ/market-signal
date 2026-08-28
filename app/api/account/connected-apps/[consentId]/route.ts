import { accountAuthConfigFromEnvironment, accountContext } from "../../../../lib/account-auth.ts";
import { openMcpOAuthDatabase, revokeConnectedMcpApp } from "../../../../lib/mcp-oauth-store.ts";

const NO_STORE = { "cache-control": "no-store, max-age=0" };

export async function DELETE(
  request: Request,
  context: { params: Promise<{ consentId: string }> },
) {
  const config = accountAuthConfigFromEnvironment(process.env);
  if (!config?.mcpEnabled) return new Response(null, { status: 404, headers: NO_STORE });
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== new URL(request.url).origin) {
    return Response.json({ code: "origin_rejected", error: "This request must come from Market Signal." }, { status: 403, headers: NO_STORE });
  }
  const account = await accountContext(request);
  if (!account) {
    return Response.json({ code: "authentication_required", error: "Sign in to revoke a connected app." }, { status: 401, headers: NO_STORE });
  }
  const { consentId } = await context.params;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(consentId)) {
    return Response.json({ code: "invalid_consent", error: "The connected app reference is invalid." }, { status: 400, headers: NO_STORE });
  }
  const database = await openMcpOAuthDatabase();
  try {
    if (!revokeConnectedMcpApp(database, account.user.id, consentId)) {
      return Response.json({ code: "connected_app_not_found", error: "That connected app is not available." }, { status: 404, headers: NO_STORE });
    }
    return Response.json({ revoked: true }, { headers: NO_STORE });
  } finally {
    database.close();
  }
}
