import { accountAuthConfigFromEnvironment, accountContext } from "../../../lib/account-auth.ts";
import {
  listConnectedMcpApps,
  listRecentMcpConnectionEvents,
  openMcpOAuthDatabase,
} from "../../../lib/mcp-oauth-store.ts";

const NO_STORE = { "cache-control": "no-store, max-age=0" };

export async function GET(request: Request) {
  const config = accountAuthConfigFromEnvironment(process.env);
  if (!config?.mcpEnabled) return new Response(null, { status: 404, headers: NO_STORE });
  const account = await accountContext(request);
  if (!account) {
    return Response.json({ code: "authentication_required", error: "Sign in to manage connected apps." }, { status: 401, headers: NO_STORE });
  }
  const database = await openMcpOAuthDatabase();
  try {
    return Response.json({
      apps: listConnectedMcpApps(database, account.user.id),
      recentEvents: listRecentMcpConnectionEvents(database, account.user.id),
    }, { headers: NO_STORE });
  } finally {
    database.close();
  }
}
