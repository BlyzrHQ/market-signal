import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createMarketSignalMcpHandler } from "../app/lib/mcp-read-server.ts";
import { ReportQueryError } from "../app/lib/report-query-service.ts";
import { createReportRun, listWorkspaceReportPage } from "../app/lib/report-store.ts";
import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { McpAccessTokenError } from "../app/lib/mcp-token-verifier.ts";
import {
  nonPostMarketSignalMcp,
  postMarketSignalMcp,
} from "../app/mcp/route.ts";

const BASE_URL = "https://signal.blyzr.com/mcp";
const PUBLIC_ID = "a".repeat(32);
const MODERN_VERSION = "2026-07-28";
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
};

function authInfo(scopes) {
  return {
    token: "signed.jwt.token",
    clientId: "https://client.example/mcp.json",
    scopes: ["offline_access", ...scopes],
    expiresAt: 2_000_000_000,
    resource: new URL(BASE_URL),
    extra: { workspaceId: "workspace-owner", userId: "user-owner" },
  };
}

function readServices(overrides = {}) {
  return {
    listReports: async (workspaceId) => ({
      items: [{ publicId: PUBLIC_ID, primaryDomain: `${workspaceId}.example`, status: "complete", createdAt: "2026-08-28T08:00:00.000Z", updatedAt: "2026-08-28T08:01:00.000Z" }],
      nextCursor: "next-page",
    }),
    getReport: async (workspaceId, publicId) => ({
      run: { publicId, primaryDomain: `${workspaceId}.example`, status: "complete" },
      events: [],
      document: { blocks: [] },
      documentSchemaVersion: 1,
      documentObservedAt: "2026-08-28T08:01:00.000Z",
    }),
    listReportMatches: async (workspaceId, publicId) => ({
      authoritative: true,
      manifestHash: "f".repeat(64),
      totalCount: workspaceId === "workspace-owner" && publicId === PUBLIC_ID ? 1 : 0,
      directPriceCount: 1,
      domainCounts: { "rival.example": 1 },
      items: [{ primary: { title: "Product" }, rival: { title: "Rival", price: 10 }, match: { confidence: 0.9 }, key: "match-1" }],
      nextCursor: null,
    }),
    listPriceWatches: async (workspaceId) => ({
      usage: { planTier: "solo", allocation: 100, used: 1, remaining: 99, periodStart: "2026-08-01", periodEnd: "2026-09-01", projectedDaily: 1, projectedMonthly: 30 },
      watchers: [{ id: "watch-1", workspaceId, canonicalUrl: "https://rival.example/product", resolvedUrl: "https://rival.example/product", sourceDomain: "rival.example", rivalDomain: "rival.example", productName: "Rival", variantKey: "default", variant: {}, cadence: "daily", state: "active", pauseReason: "", baseline: null, failureStreak: 0, nextCheckAt: "", lastCheckAt: "", createdAt: "", updatedAt: "", links: [] }],
    }),
    getPriceWatchHistory: async (workspaceId, watcherId) => [{ id: `${workspaceId}:${watcherId}`, kind: "price", currency: "USD", amountMicros: 10_000_000, raw: "$10", listAmountMicros: null, listRaw: "", observedAt: "2026-08-28T08:00:00.000Z" }],
    listNotifications: async (actor) => ({ unread: 1, items: [{ id: "note-1", watcherId: `watch:${actor.workspaceId}`, type: "discount", title: "Price dropped", body: "The price changed.", createdAt: "2026-08-28T08:00:00.000Z", read: false }] }),
    ...overrides,
  };
}

function routeServices(scopes, overrides = {}) {
  const handler = createMarketSignalMcpHandler(readServices(overrides.readServices));
  return {
    enabled: () => true,
    openDatabase: async () => ({ close() {} }),
    verify: async (_database, token) => {
      assert.equal(token, "signed.jwt.token");
      return authInfo(scopes);
    },
    handler,
    ...overrides,
  };
}

function protocolRequest(method, params = {}, headers = {}) {
  const requestHeaders = {
    authorization: "Bearer signed.jwt.token",
    "content-type": "application/json; charset=utf-8",
    host: "signal.blyzr.com",
    "mcp-method": method,
    "mcp-protocol-version": MODERN_VERSION,
    ...headers,
  };
  if (method === "tools/call" && params.name) requestHeaders["mcp-name"] = params.name;
  return new Request(BASE_URL, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: ENVELOPE },
    }),
  });
}

async function protocolJson(request, services) {
  const response = await postMarketSignalMcp(request, services);
  return { response, body: await response.json() };
}

test("MCP tool discovery exposes only tools granted by the verified token", async () => {
  const reports = routeServices(["reports:read"]);
  const reportList = await protocolJson(protocolRequest("tools/list"), reports);
  assert.equal(reportList.response.status, 200);
  assert.deepEqual(reportList.body.result.tools.map((tool) => tool.name), ["reports_list", "report_get", "report_matches_list"]);
  assert.equal(reportList.response.headers.get("cache-control"), "private, no-store, max-age=0");
  await reports.handler.close();

  const watches = routeServices(["price_watch:read"]);
  const watchList = await protocolJson(protocolRequest("tools/list"), watches);
  assert.deepEqual(watchList.body.result.tools.map((tool) => tool.name), ["price_watch_list", "price_watch_history", "notifications_list"]);
  await watches.handler.close();

  const writesOnly = routeServices(["reports:create", "price_watch:write"]);
  const empty = await protocolJson(protocolRequest("tools/list"), writesOnly);
  assert.deepEqual(empty.body.result.tools, []);
  await writesOnly.handler.close();
});

test("report tools use the verified workspace and return credential-free private links", async () => {
  const services = routeServices(["reports:read"]);
  const listed = await protocolJson(protocolRequest("tools/call", {
    name: "reports_list",
    arguments: { limit: 10 },
  }), services);
  assert.equal(listed.response.status, 200);
  const output = listed.body.result.structuredContent;
  assert.equal(output.reports[0].primaryDomain, "workspace-owner.example");
  assert.equal(output.reports[0].privateUrl, `https://signal.blyzr.com/reports/${PUBLIC_ID}`);
  assert.doesNotMatch(JSON.stringify(output), /signed\.jwt\.token|workspaceId|billingReservationId/);

  const matches = await protocolJson(protocolRequest("tools/call", {
    name: "report_matches_list",
    arguments: { publicReportId: PUBLIC_ID, limit: 20 },
  }), services);
  assert.equal(matches.body.result.structuredContent.totalCount, 1);
  assert.equal(matches.body.result.structuredContent.items[0].rival.price, 10);
  await services.handler.close();
});

test("price-watch reads redact workspace ids and bind history and notifications to the principal", async () => {
  const services = routeServices(["price_watch:read"]);
  const listed = await protocolJson(protocolRequest("tools/call", {
    name: "price_watch_list",
    arguments: {},
  }), services);
  const listOutput = listed.body.result.structuredContent;
  assert.equal(listOutput.watchers[0].id, "watch-1");
  assert.equal("workspaceId" in listOutput.watchers[0], false);

  const history = await protocolJson(protocolRequest("tools/call", {
    name: "price_watch_history",
    arguments: { watcherId: "watch-1", limit: 20 },
  }), services);
  assert.equal(history.body.result.structuredContent.history[0].id, "workspace-owner:watch-1");

  const notifications = await protocolJson(protocolRequest("tools/call", {
    name: "notifications_list",
    arguments: { limit: 10 },
  }), services);
  assert.equal(notifications.body.result.structuredContent.items[0].watcherId, "watch:workspace-owner");
  await services.handler.close();
});

test("cross-workspace report identifiers collapse to a safe not-found tool result", async () => {
  const services = routeServices(["reports:read"], {
    readServices: {
      ...readServices(),
      getReport: async () => { throw new ReportQueryError(); },
    },
  });
  const result = await protocolJson(protocolRequest("tools/call", {
    name: "report_get",
    arguments: { publicReportId: PUBLIC_ID },
  }), services);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.result.isError, true);
  assert.equal(result.body.result.structuredContent.error.code, "not-found");
  await services.handler.close();
});

test("MCP route rejects cookie-only, invalid host/origin, non-JSON, oversized, and legacy requests", async () => {
  const services = routeServices(["reports:read"]);
  const cookieOnly = protocolRequest("tools/list", {}, { authorization: "", cookie: "better-auth.session_token=secret" });
  const missingBearer = await postMarketSignalMcp(cookieOnly, services);
  assert.equal(missingBearer.status, 401);
  assert.match(missingBearer.headers.get("www-authenticate"), /resource_metadata=/);
  assert.doesNotMatch(await missingBearer.text(), /session_token|secret/);

  assert.equal((await postMarketSignalMcp(protocolRequest("tools/list", {}, { host: "attacker.example" }), services)).status, 403);
  assert.equal((await postMarketSignalMcp(protocolRequest("tools/list", {}, { origin: "https://attacker.example" }), services)).status, 403);
  assert.equal((await postMarketSignalMcp(protocolRequest("tools/list", {}, { "content-type": "text/plain" }), services)).status, 415);
  assert.equal((await postMarketSignalMcp(protocolRequest("tools/list", {}, { "content-length": String(300_000) }), services)).status, 400);

  const legacy = new Request(BASE_URL, {
    method: "POST",
    headers: { authorization: "Bearer signed.jwt.token", "content-type": "application/json", host: "signal.blyzr.com" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
  });
  const legacyResponse = await postMarketSignalMcp(legacy, services);
  assert.equal(legacyResponse.status, 400);
  assert.match(await legacyResponse.text(), /Unsupported protocol version/);
  await services.handler.close();
});

test("MCP route returns safe OAuth errors for invalid, revoked, and unavailable authorization", async () => {
  for (const [code, status] of [["invalid_token", 401], ["insufficient_scope", 403], ["authorization_unavailable", 503]]) {
    const services = routeServices(["reports:read"], {
      verify: async () => { throw new McpAccessTokenError(code, `safe ${code}`, status); },
    });
    const response = await postMarketSignalMcp(protocolRequest("tools/list"), services);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, code);
    assert.equal(Boolean(response.headers.get("www-authenticate")), status !== 503);
    await services.handler.close();
  }
});

test("the hosted MCP endpoint is explicitly POST-only", async () => {
  const response = nonPostMarketSignalMcp({ enabled: () => true });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(nonPostMarketSignalMcp({ enabled: () => false }).status, 404);
});

test("workspace report pagination is stable, opaque, and tenant-bound", async () => {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-mcp-report-page-"));
  const database = await NodeSqliteDatabase.open(join(directory, "reports.sqlite"));
  try {
    for (let index = 0; index < 3; index += 1) {
      await createReportRun({ primaryDomain: `shop-${index}.example`, workspaceId: "workspace-owner" }, new Date(`2026-08-2${8 - index}T08:00:00.000Z`), database);
    }
    await createReportRun({ primaryDomain: "foreign.example", workspaceId: "workspace-foreign" }, new Date("2026-08-28T09:00:00.000Z"), database);

    const first = await listWorkspaceReportPage("workspace-owner", { limit: 2, now: new Date("2026-08-28T12:00:00.000Z") }, database);
    assert.deepEqual(first.items.map((report) => report.primaryDomain), ["shop-0.example", "shop-1.example"]);
    assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(first.nextCursor, /shop|2026/);

    const second = await listWorkspaceReportPage("workspace-owner", { limit: 2, cursor: first.nextCursor, now: new Date("2026-08-28T12:00:00.000Z") }, database);
    assert.deepEqual(second.items.map((report) => report.primaryDomain), ["shop-2.example"]);
    assert.equal(second.nextCursor, null);
    await assert.rejects(() => listWorkspaceReportPage("workspace-owner", { cursor: `${first.nextCursor}broken` }, database), /Invalid report cursor/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
