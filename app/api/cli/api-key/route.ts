import { accountAuthConfigFromEnvironment } from "../../../lib/account-auth.ts";
import { openMcpOAuthDatabase } from "../../../lib/mcp-oauth-store.ts";
import { revokePresentedReportApiKey } from "../../../lib/report-api-keys.ts";

const NO_STORE = { "cache-control": "no-store, max-age=0" };

function bearerToken(value: string | null) {
  if (!value || value.length > 256) return "";
  return /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value)?.[1] || "";
}

export async function revokeCurrentReportApiKey(
  request: Request,
  services = {
    enabled: () => Boolean(accountAuthConfigFromEnvironment(process.env)?.mcpEnabled),
    openDatabase: openMcpOAuthDatabase,
  },
) {
  if (!services.enabled()) return new Response(null, { status: 404, headers: NO_STORE });
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return Response.json({ ok: false, error: "A valid API key is required.", errorCode: "authentication-required" }, { status: 401, headers: NO_STORE });
  let database: Awaited<ReturnType<typeof openMcpOAuthDatabase>> | undefined;
  try {
    database = await services.openDatabase();
    if (!revokePresentedReportApiKey(database, token)) {
      return Response.json({ ok: false, error: "A valid API key is required.", errorCode: "authentication-required" }, { status: 401, headers: NO_STORE });
    }
    return Response.json({ ok: true, revoked: true }, { headers: NO_STORE });
  } catch {
    console.error("Presented report API key could not be revoked.", { errorCode: "report-api-key-self-revoke-failed" });
    return Response.json({ ok: false, error: "API key revocation is temporarily unavailable.", errorCode: "storage-unavailable" }, { status: 503, headers: NO_STORE });
  } finally {
    database?.close();
  }
}

export async function DELETE(request: Request) {
  return revokeCurrentReportApiKey(request);
}
