import { mcpOAuthMetadataResponse } from "../../lib/mcp-oauth-metadata.ts";

export function GET(request: Request) {
  return mcpOAuthMetadataResponse(request, "/.well-known/oauth-protected-resource");
}

export function HEAD(request: Request) {
  return mcpOAuthMetadataResponse(request, "/.well-known/oauth-protected-resource");
}
