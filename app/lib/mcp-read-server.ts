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
import {
  confirmMcpReportCreate,
  confirmMcpPriceWatchActivation,
  confirmMcpPriceWatchDelete,
  confirmMcpPriceWatchUpdate,
  disableMcpPriceWatch,
  getMcpAccountStatus,
  McpWriteServiceError,
  previewMcpReportCreate,
  previewMcpPriceWatchActivation,
  previewMcpPriceWatchDelete,
  previewMcpPriceWatchUpdate,
} from "./mcp-write-service.ts";
import { McpCommandStoreError } from "./mcp-command-store.ts";

const REPORT_ID = /^[a-f0-9]{32}$/;
const TERMINAL_REPORT_STATUSES = new Set(["complete", "limited", "failed", "interrupted"]);

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const PREVIEW_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const REPORT_CONFIRM_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const IDEMPOTENT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const DESTRUCTIVE_CONFIRM_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
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

export type McpWriteToolServices = {
  accountStatus: typeof getMcpAccountStatus;
  previewReportCreate: typeof previewMcpReportCreate;
  confirmReportCreate: typeof confirmMcpReportCreate;
  previewPriceWatchActivation: typeof previewMcpPriceWatchActivation;
  confirmPriceWatchActivation: typeof confirmMcpPriceWatchActivation;
  previewPriceWatchUpdate: typeof previewMcpPriceWatchUpdate;
  confirmPriceWatchUpdate: typeof confirmMcpPriceWatchUpdate;
  disablePriceWatch: typeof disableMcpPriceWatch;
  previewPriceWatchDelete: typeof previewMcpPriceWatchDelete;
  confirmPriceWatchDelete: typeof confirmMcpPriceWatchDelete;
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

export function mcpWriteToolServices(): McpWriteToolServices {
  return {
    accountStatus: getMcpAccountStatus,
    previewReportCreate: previewMcpReportCreate,
    confirmReportCreate: confirmMcpReportCreate,
    previewPriceWatchActivation: previewMcpPriceWatchActivation,
    confirmPriceWatchActivation: confirmMcpPriceWatchActivation,
    previewPriceWatchUpdate: previewMcpPriceWatchUpdate,
    confirmPriceWatchUpdate: confirmMcpPriceWatchUpdate,
    disablePriceWatch: disableMcpPriceWatch,
    previewPriceWatchDelete: previewMcpPriceWatchDelete,
    confirmPriceWatchDelete: confirmMcpPriceWatchDelete,
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

function outcomeToolResult(value: Record<string, unknown>): CallToolResult {
  const error = value.ok === false && value.error && typeof value.error === "object"
    ? value.error as Record<string, unknown>
    : null;
  if (!error) return successfulToolResult(value);
  const structuredContent = jsonRecord(value);
  return {
    isError: true,
    content: [{ type: "text", text: `${String(error.code || "command-failed")}: ${String(error.message || "The command failed.")}` }],
    structuredContent,
  };
}

function safeToolFailure(error: unknown, operation: string): CallToolResult {
  if (error instanceof ReportQueryError) {
    return failedToolResult("not-found", "Report not found.");
  }
  if (error instanceof PriceWatchStoreError) {
    if (error.code === "watcher-not-found" || error.code === "report-not-found") {
      return failedToolResult("not-found", "Price watch not found.");
    }
    return failedToolResult(error.code, error.message);
  }
  if (error instanceof McpWriteServiceError || error instanceof McpCommandStoreError) {
    return failedToolResult(error.code, error.message);
  }
  if (error instanceof Error && /^Invalid .*cursor\.$/.test(error.message)) {
    return failedToolResult("invalid-argument", error.message);
  }
  console.error("Market Signal MCP read tool failed.", {
    errorCode: "mcp-read-tool-failed",
    operation,
    errorName: error instanceof Error ? error.name : "unknown",
  });
  return failedToolResult("temporarily-unavailable", "Market Signal data is temporarily unavailable.");
}

function registerAccountStatusTool(server: McpServer, principal: McpPrincipal, scopes: string[], services: McpWriteToolServices) {
  server.registerTool(
    "account_status",
    {
      title: "Get Market Signal account status",
      description: "Get plan and usage status, limited to the report and price-watch scope families granted to this connection.",
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        return successfulToolResult(await services.accountStatus(principal, scopes));
      } catch (error) {
        return safeToolFailure(error, "account_status");
      }
    },
  );
}

function registerReportWriteTools(server: McpServer, principal: McpPrincipal, services: McpWriteToolServices) {
  server.registerTool(
    "report_create_preview",
    {
      title: "Preview a Market Signal report",
      description: "Validate a domain and show the exact plan and report-quota impact without reserving quota or starting work. Returns a five-minute confirmation token.",
      inputSchema: z.object({
        primaryDomain: z.string().min(1).max(2_048),
        locale: z.enum(["en", "ar"]).default("en"),
      }).strict(),
      annotations: PREVIEW_ANNOTATIONS,
    },
    async ({ primaryDomain, locale }) => {
      try {
        return successfulToolResult(await services.previewReportCreate(principal, { primaryDomain, locale }));
      } catch (error) {
        return safeToolFailure(error, "report_create_preview");
      }
    },
  );

  server.registerTool(
    "report_create_confirm",
    {
      title: "Confirm a Market Signal report",
      description: "Use a report preview confirmation token to reserve quota and dispatch exactly one private report. Retrying the same token safely replays its outcome.",
      inputSchema: z.object({ confirmationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
      annotations: REPORT_CONFIRM_ANNOTATIONS,
    },
    async ({ confirmationToken }) => {
      try {
        return outcomeToolResult(await services.confirmReportCreate(principal, confirmationToken));
      } catch (error) {
        return safeToolFailure(error, "report_create_confirm");
      }
    },
  );
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
        return safeToolFailure(error, "reports_list");
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
        return safeToolFailure(error, "report_get");
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
        return safeToolFailure(error, "report_matches_list");
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
        return safeToolFailure(error, "price_watch_list");
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
        return safeToolFailure(error, "price_watch_history");
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
        return safeToolFailure(error, "notifications_list");
      }
    },
  );
}

function registerPriceWatchWriteTools(server: McpServer, principal: McpPrincipal, services: McpWriteToolServices) {
  server.registerTool(
    "price_watch_preview",
    {
      title: "Preview price-watch activation",
      description: "Preview eligible saved comparisons, watcher reuse, cadence, and monitoring-credit impact for one match or one rival snapshot. Does not reserve credits.",
      inputSchema: z.object({
        publicReportId: z.string().regex(REPORT_ID),
        cadence: z.enum(["hourly", "daily"]),
        matchId: z.string().min(1).max(100).optional(),
        rivalDomain: z.string().min(1).max(253).optional(),
      }).strict(),
      annotations: PREVIEW_ANNOTATIONS,
    },
    async (input) => {
      try {
        return successfulToolResult(await services.previewPriceWatchActivation(principal, input));
      } catch (error) {
        return safeToolFailure(error, "price_watch_preview");
      }
    },
  );

  server.registerTool(
    "price_watch_confirm",
    {
      title: "Confirm price-watch activation",
      description: "Activate the exact price-watch preview. Retrying the same five-minute token safely replays the recorded outcome.",
      inputSchema: z.object({ confirmationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ confirmationToken }) => {
      try {
        return outcomeToolResult(await services.confirmPriceWatchActivation(principal, confirmationToken));
      } catch (error) {
        return safeToolFailure(error, "price_watch_confirm");
      }
    },
  );

  server.registerTool(
    "price_watch_update_preview",
    {
      title: "Preview a price-watch update",
      description: "Preview a cadence change or resume action, including projected checks and any fresh-baseline credit.",
      inputSchema: z.object({
        watcherId: z.string().min(1).max(100),
        cadence: z.enum(["hourly", "daily"]).optional(),
        action: z.literal("resume").optional(),
      }).strict(),
      annotations: PREVIEW_ANNOTATIONS,
    },
    async (input) => {
      try {
        return successfulToolResult(await services.previewPriceWatchUpdate(principal, input));
      } catch (error) {
        return safeToolFailure(error, "price_watch_update_preview");
      }
    },
  );

  server.registerTool(
    "price_watch_update_confirm",
    {
      title: "Confirm a price-watch update",
      description: "Apply the exact cadence or resume preview. Retrying the same token safely replays its outcome.",
      inputSchema: z.object({ confirmationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ confirmationToken }) => {
      try {
        return outcomeToolResult(await services.confirmPriceWatchUpdate(principal, confirmationToken));
      } catch (error) {
        return safeToolFailure(error, "price_watch_update_confirm");
      }
    },
  );

  server.registerTool(
    "price_watch_disable",
    {
      title: "Disable a price watch",
      description: "Immediately and idempotently stop one workspace-owned price watch while preserving its saved history.",
      inputSchema: z.object({ watcherId: z.string().min(1).max(100) }).strict(),
      annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
    },
    async ({ watcherId }) => {
      try {
        return successfulToolResult(await services.disablePriceWatch(principal, watcherId));
      } catch (error) {
        return safeToolFailure(error, "price_watch_disable");
      }
    },
  );

  server.registerTool(
    "price_watch_delete_preview",
    {
      title: "Preview permanent price-watch deletion",
      description: "Show the watcher data that permanent deletion will remove and issue a five-minute confirmation token.",
      inputSchema: z.object({ watcherId: z.string().min(1).max(100) }).strict(),
      annotations: PREVIEW_ANNOTATIONS,
    },
    async ({ watcherId }) => {
      try {
        return successfulToolResult(await services.previewPriceWatchDelete(principal, watcherId));
      } catch (error) {
        return safeToolFailure(error, "price_watch_delete_preview");
      }
    },
  );

  server.registerTool(
    "price_watch_delete_confirm",
    {
      title: "Confirm permanent price-watch deletion",
      description: "Permanently delete the exact previewed watcher and its linked history. Consumed monitoring credits remain charged.",
      inputSchema: z.object({ confirmationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
      annotations: DESTRUCTIVE_CONFIRM_ANNOTATIONS,
    },
    async ({ confirmationToken }) => {
      try {
        return outcomeToolResult(await services.confirmPriceWatchDelete(principal, confirmationToken));
      } catch (error) {
        return safeToolFailure(error, "price_watch_delete_confirm");
      }
    },
  );
}

export function createMarketSignalMcpHandler(
  services: McpReadServices = mcpReadServices(),
  writeServices: McpWriteToolServices = mcpWriteToolServices(),
): McpHttpHandler {
  return createMcpHandler(({ authInfo }: { authInfo?: AuthInfo }) => {
    const server = new McpServer({ name: "market-signal", version: "1.1.0" });
    // Keep `tools/list` available even when the token currently grants only
    // write scopes whose tools ship in the next stage. Disabled tools are not
    // advertised and cannot be called.
    server.registerTool("market_signal_scope_gate", {
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    }, async () => failedToolResult("insufficient-scope", "No callable tool is granted.")).disable();
    const principal = mcpPrincipalFromAuthInfo(authInfo);
    if (!principal || !authInfo) return server;
    if (authInfo.scopes.some((scope) => ["reports:read", "reports:create", "price_watch:read", "price_watch:write"].includes(scope))) {
      registerAccountStatusTool(server, principal, authInfo.scopes, writeServices);
    }
    if (authInfo.scopes.includes("reports:read")) registerReportTools(server, principal, services);
    if (authInfo.scopes.includes("reports:create")) registerReportWriteTools(server, principal, writeServices);
    if (authInfo.scopes.includes("price_watch:read")) registerPriceWatchTools(server, principal, services);
    if (authInfo.scopes.includes("price_watch:write")) registerPriceWatchWriteTools(server, principal, writeServices);
    return server;
  }, {
    legacy: "reject",
    responseMode: "auto",
    onerror: () => console.error("Market Signal MCP protocol request failed.", { errorCode: "mcp-protocol-error" }),
  });
}
