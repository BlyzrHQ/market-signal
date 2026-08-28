export const MARKET_SIGNAL_ORIGIN = "https://signal.blyzr.com";
export const MCP_RESOURCE = `${MARKET_SIGNAL_ORIGIN}/mcp`;
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MCP_CLOCK_TOLERANCE_SECONDS = 60;

export const MCP_RESOURCE_SCOPES = [
  "reports:read",
  "reports:create",
  "price_watch:read",
  "price_watch:write",
] as const;

export const MCP_AUTHORIZATION_SCOPES = [
  ...MCP_RESOURCE_SCOPES,
  "offline_access",
] as const;

export type McpResourceScope = (typeof MCP_RESOURCE_SCOPES)[number];

export const MCP_SCOPE_DETAILS: Record<McpResourceScope, { title: string; description: string }> = {
  "reports:read": {
    title: "Read your reports",
    description: "View reports and comparison results owned by your Market Signal workspace.",
  },
  "reports:create": {
    title: "Create reports",
    description: "Start reports in your workspace. Every created report consumes your plan's report quota.",
  },
  "price_watch:read": {
    title: "Read price watches",
    description: "View your watched products, schedules, recent checks, and price-change notifications.",
  },
  "price_watch:write": {
    title: "Manage price watches",
    description: "Create, change, pause, resume, or remove watches. Scheduled checks can consume monitoring credits.",
  },
};

export function normalizeMcpScopes(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.filter((scope): scope is string => typeof scope === "string"))];
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return normalizeMcpScopes(parsed);
  } catch {
    // Space-delimited OAuth scopes are handled below.
  }
  return [...new Set(trimmed.split(/\s+/).filter(Boolean))];
}

export function mcpClientIdentity(clientId: string, selfAssertedName?: string | null) {
  let host = clientId;
  try {
    host = new URL(clientId).host;
  } catch {
    // Preserve the opaque ID for explicitly registered test clients.
  }
  return {
    clientId,
    host,
    name: String(selfAssertedName || "").trim() || host,
    verified: false as const,
  };
}
