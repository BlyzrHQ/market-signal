import { accountAuthConfigFromEnvironment, configuredAccountAuth } from "./account-auth.ts";
import { MCP_RESOURCE, MCP_RESOURCE_SCOPES } from "./mcp-oauth-shared.ts";

export async function mcpOAuthMetadataResponse(request: Request, metadataPath: string) {
  const config = accountAuthConfigFromEnvironment(process.env);
  if (!config?.mcpEnabled) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const headers = new Headers({
    "cache-control": "no-store, max-age=0",
    "content-type": "application/json",
  });
  let body: Record<string, unknown>;
  if (metadataPath === "/.well-known/oauth-authorization-server") {
    const auth = await configuredAccountAuth();
    if (!auth) return new Response(null, { status: 404, headers });
    body = { ...await auth.api.getOAuthServerConfig({ headers: request.headers }) };
  } else {
    body = {
      resource: MCP_RESOURCE,
      authorization_servers: [config.baseURL],
      bearer_methods_supported: ["header"],
      scopes_supported: [...MCP_RESOURCE_SCOPES],
    };
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), { status: 200, headers });
}
