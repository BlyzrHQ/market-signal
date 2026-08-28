import { mcpOAuthMetadataResponse } from "../../../lib/mcp-oauth-metadata.ts";

export function GET(request: Request) {
  return mcpOAuthMetadataResponse(request, "/.well-known/oauth-authorization-server");
}

export function HEAD(request: Request) {
  return mcpOAuthMetadataResponse(request, "/.well-known/oauth-authorization-server");
}
