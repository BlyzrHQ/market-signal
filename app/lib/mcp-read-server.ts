import {
  McpServer,
  createMcpHandler,
  type AuthInfo,
  type CallToolResult,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  getWorkspaceReport,
  getWorkspaceReportMatches,
  listWorkspaceReportSummaryPage,
  ReportQueryError,
} from "./report-query-service.ts";
import {
  getWorkspacePriceWatchHistory,
  listWorkspacePriceWatchers,
  listWorkspacePriceWatchNotifications,
} from "./price-watch-service.ts";
import { PriceWatchStoreError, type PriceWatcher } from "./price-watch-store.ts";
import { MARKET_SIGNAL_ORIGIN } from "./mcp-oauth-shared.ts";
import { mcpPrincipalFromAuthInfo, type McpPrincipal } from "./mcp-token-verifier.ts";

const REPORT_ID = /^[a-f0-9]{32}$/;
const TERMINAL_REPORT_STATUSES = new Set(["complete", "limited", "failed", "interrupted"]);

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export type McpReadServices = {
  listReports: typeof listWorkspaceReportSummaryPage;
  getReport: typeof getWorkspaceReport;
  listReportMatches: typeof getWorkspaceReportMatches;
  listPriceWatches: typeof listWorkspacePriceWatchers;
  getPriceWatchHistory: typeof getWorkspacePriceWatchHistory;
  listNotifications: typeof listWorkspacePriceWatchNotifications;
};

export function mcpReadServices(): McpReadServices {
  return {
    listReports: listWorkspaceReportSummaryPage,
    getReport: getWorkspaceReport,
    listReportMatches: getWorkspaceReportMatches,
    listPriceWatches: listWorkspacePriceWatchers,
    getPriceWatchHistory: getWorkspacePriceWatchHistory,
    listNotifications: listWorkspacePriceWatchNotifications,
  };
}

function jsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function successfulToolResult(value: Record<string, unknown>): CallToolResult {
  const structuredContent = jsonRecord(value);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failedToolResult(code: string, message: string): CallToolResult {
  const structuredContent = { ok: false, error: { code, message } };
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent,
  };
}

function safeToolFailure(error: unknown): CallToolResult {
  if (error instanceof ReportQueryError) {
    return failedToolResult("not-found", "Report not found.");
  }
  if (error instanceof PriceWatchStoreError) {
    if (error.code === "watcher-not-found" || error.code === "report-not-found") {
      return failedToolResult("not-found", "Price watch not found.");
    }
    return failedToolResult(error.code, error.message);
  }
  if (error instanceof Error && /^Invalid .*cursor\.$/.test(error.message)) {
    return failedToolResult("invalid-argument", error.message);
  }
  console.error("Market Signal MCP read tool failed.", { errorCode: "mcp-read-tool-failed" });
  return failedToolResult("temporarily-unavailable", "Market Signal data is temporarily unavailable.");
}

function privateReportUrl(publicId: string) {
  return `${MARKET_SIGNAL_ORIGIN}/reports/${publicId}`;
}

function customerWatcher(watcher: PriceWatcher) {
  const customerSafe: Partial<PriceWatcher> = { ...watcher };
  delete customerSafe.workspaceId;
  return customerSafe;
}

function registerReportTools(server: McpServer, principal: McpPrincipal, services: McpReadServices) {
  server.registerTool(
    "reports_list",
    {
      title: "List Market Signal reports",
      description: "List a bounded page of private reports owned by the connected Market Signal account.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(10),
        cursor: z.string().min(1).max(500).optional(),
      }).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, cursor }) => {
      try {
        const page = await services.listReports(principal.workspaceId, { limit, cursor });
        return successfulToolResult({
          ok: true,
          reports: page.items.map((report) => ({ ...report, privateUrl: privateReportUrl(report.publicId) })),
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        return safeToolFailure(error);
      }
    },
  );

  server.registerTool(
    "report_get",
    {
      title: "Get a Market Signal report",
      description: "Retrieve one private, workspace-owned report and its current lifecycle state.",
      inputSchema: z.object({ publicReportId: z.string().regex(REPORT_ID) }).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ publicReportId }) => {
      try {
        const report = await services.getReport(principal.workspaceId, publicReportId);
        const terminal = TERMINAL_REPORT_STATUSES.has(String(report.run.status || ""));
        return successfulToolResult({
          ok: true,
          report,
          privateUrl: privateReportUrl(publicReportId),
          pollAfterSeconds: terminal ? null : 10,
        });
      } catch (error) {
        return safeToolFailure(error);
      }
    },
  );

  server.registerTool(
    "report_matches_list",
    {
      title: "List report comparisons",
      description: "List a bounded page of authoritative saved product comparisons from a private report.",
      inputSchema: z.object({
        publicReportId: z.string().regex(REPORT_ID),
        cursor: z.string().min(1).max(500).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ publicReportId, cursor, limit }) => {
      try {
        const page = await services.listReportMatches(principal.workspaceId, publicReportId, { cursor, limit });
        return successfulToolResult({ ok: true, publicReportId, ...page });
      } catch (error) {
        return safeToolFailure(error);
      }
    },
  );
}

function registerPriceWatchTools(server: McpServer, principal: McpPrincipal, services: McpReadServices) {
  server.registerTool(
    "price_watch_list",
    {
      title: "List price watches",
      description: "List price watches and monitoring-credit usage owned by the connected account.",
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const result = await services.listPriceWatches(principal.workspaceId);
        return successfulToolResult({
          ok: true,
          usage: result.usage,
          watchers: result.watchers.map(customerWatcher),
        });
      } catch (error) {
        return safeToolFailure(error);
      }
    },
  );

  server.registerTool(
    "price_watch_history",
    {
      title: "Get price-watch history",
      description: "Retrieve bounded observed-price history for one workspace-owned price watch.",
      inputSchema: z.object({
        watcherId: z.string().min(1).max(100),
        limit: z.number().int().min(1).max(500).default(100),
      }).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ watcherId, limit }) => {
      try {
        const history = await services.getPriceWatchHistory(principal.workspaceId, watcherId, limit);
        return successfulToolResult({ ok: true, watcherId, history });
      } catch (error) {
        return safeToolFailure(error);
      }
    },
  );

  server.registerTool(
    "notifications_list",
    {
      title: "List price-watch notifications",
      description: "List bounded, read-only price-change and discount notifications for the connected account.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(50) }).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit }) => {
      try {
        const notifications = await services.listNotifications(principal, limit);
        return successfulToolResult({ ok: true, ...notifications });
      } catch (error) {
        return safeToolFailure(error);
      }
    },
  );
}

export function createMarketSignalMcpHandler(
  services: McpReadServices = mcpReadServices(),
): McpHttpHandler {
  return createMcpHandler(({ authInfo }: { authInfo?: AuthInfo }) => {
    const server = new McpServer({ name: "market-signal", version: "1.0.0" });
    // Keep `tools/list` available even when the token currently grants only
    // write scopes whose tools ship in the next stage. Disabled tools are not
    // advertised and cannot be called.
    server.registerTool("market_signal_scope_gate", {
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    }, async () => failedToolResult("insufficient-scope", "No callable tool is granted.")).disable();
    const principal = mcpPrincipalFromAuthInfo(authInfo);
    if (!principal || !authInfo) return server;
    if (authInfo.scopes.includes("reports:read")) registerReportTools(server, principal, services);
    if (authInfo.scopes.includes("price_watch:read")) registerPriceWatchTools(server, principal, services);
    return server;
  }, {
    legacy: "reject",
    responseMode: "auto",
    onerror: () => console.error("Market Signal MCP protocol request failed.", { errorCode: "mcp-protocol-error" }),
  });
}
