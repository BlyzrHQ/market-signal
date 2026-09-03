import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPersistentReport } from "../app/api/reports/route.ts";
import { getReportLoopResult } from "../app/api/reports/[publicId]/result/route.ts";
import { getReportComparisonResult } from "../app/api/reports/[publicId]/result/comparisons/route.ts";
import { CONTROLLED_CLI_WORKSPACE_ID, reportApiAccountContext } from "../app/lib/report-api-auth.ts";
import { createReportCommand } from "../app/lib/report-command-service.ts";
import { ReportLoopFactsError } from "../app/lib/report-loop-projection.ts";
import { buildMarketSignalLoopResult } from "../app/lib/report-loop-result.ts";
import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { createReportRunResult, markReportDispatched } from "../app/lib/report-store.ts";

const PUBLIC_ID = "a".repeat(32);
const REQUEST_ID = "orchestrator:babanuj:001";
const TOKEN = "controlled-loop-token-12345678901234567890";
const NOW = new Date("2026-09-02T10:02:00.000Z");

function report(status = "complete", delivered = 20) {
  return {
    run: {
      id: "run_babanuj_001",
      publicId: PUBLIC_ID,
      primaryDomain: "babanuj.com",
      locale: "en",
      status,
      currentPhase: status === "running" ? "matching" : status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "complete",
      attemptCount: 1,
      createdAt: "2026-09-02T10:00:00.000Z",
      updatedAt: NOW.toISOString(),
      heartbeatAt: "2026-09-02T10:01:55.000Z",
      expiresAt: "2026-12-01T10:00:00.000Z",
      errorCode: status === "failed" ? "crawl-failed" : status === "interrupted" ? "stale-worker" : "",
      errorMessage: status === "failed" ? "The primary storefront could not be crawled." : "",
      workspaceId: CONTROLLED_CLI_WORKSPACE_ID,
      billingReservationId: "",
      productPlan: "starter",
      productLimit: 20,
      productTargetKind: "pairs",
    },
    events: [
      { sequence: 1, idempotencyKey: "crawl-complete", phase: "crawl", status: "complete", message: "Crawl complete.", metadata: {}, observedAt: "2026-09-02T10:00:30.000Z" },
      { sequence: 2, idempotencyKey: "quality-complete", phase: "quality", status: "complete", message: "Quality complete.", metadata: { repairs: delivered === 20 ? 1 : 3 }, observedAt: "2026-09-02T10:01:30.000Z" },
      { sequence: 3, idempotencyKey: "report-saved", phase: "persistence", status, message: "Report saved.", metadata: {}, observedAt: NOW.toISOString() },
    ],
    document: { primaryDomain: "babanuj.com", document: { blocks: [
      { type: "summary", body: "Bounded result" },
      { type: "competitor", domain: "rival.example", companyName: "Rival Market", relationship: "direct substitute", confidence: "High", reason: "Carries accepted priced alternatives.", verificationScore: 91, websiteSourceUrl: "https://rival.example/" },
    ] } },
    documentSchemaVersion: 1,
    documentObservedAt: NOW.toISOString(),
    factManifest: null,
    primaryProducts: { authoritative: true, totalCount: delivered, products: [], truncated: false },
  };
}

function matchPage(delivered = 20) {
  return {
    authoritative: true,
    manifestHash: "b".repeat(64),
    totalCount: delivered,
    directPriceCount: delivered,
    domainCounts: delivered ? { "rival.example": delivered } : {},
    items: Array.from({ length: Math.min(50, delivered) }, (_, index) => ({
      key: String(index + 1).padStart(64, "0"),
      primary: { id: `primary-${index + 1}`, name: `Babanuj product ${index + 1}`, domain: "babanuj.com", sourceUrl: `https://babanuj.com/products/${index + 1}`, imageUrl: "", observedAt: NOW.toISOString(), priceSignals: [{ raw: "$10.00", currency: "USD", amount: 10 }] },
      rival: { id: `rival-${index + 1}`, name: `Rival product ${index + 1}`, domain: "rival.example", sourceUrl: `https://rival.example/products/${index + 1}`, imageUrl: "", observedAt: NOW.toISOString(), priceSignals: [{ raw: "$9.00", currency: "USD", amount: 9 }] },
      match: { score: 0.91, confidence: "0.94", sharedTerms: ["hummus"], assessment: { verdict: "search_result", confidence: 0.94, method: "direct-web-search", claimType: "Inferred", reasons: ["Same product and size."], contradictions: [], normalizedCategory: "food", model: "", promptVersion: "direct-product-search-v1" }, decision: { priceComparison: { primaryRaw: "$10.00", rivalRaw: "$9.00" }, recommendedMove: "Review the verified price gap.", whyTheyMayWin: "The rival has a lower observed price." } },
    })),
    nextCursor: null,
  };
}

function routeServices(snapshot = report(), page = matchPage()) {
  return {
    now: () => NOW,
    loadAccess: async () => ({ runId: snapshot.run.id, publicId: PUBLIC_ID, workspaceId: snapshot.run.workspaceId, expiresAt: snapshot.run.expiresAt, commandId: REQUEST_ID }),
    loadReport: async () => snapshot,
    loadMatches: async () => page,
    loadEvaluation: async () => null,
    authorize: async () => ({ user: { id: "controlled-cli", name: "Controlled CLI", email: "" }, workspaceId: snapshot.run.workspaceId }),
    settle: async () => true,
  };
}

function comparisonRouteServices(snapshot = report(), loadMatches = async () => matchPage()) {
  return {
    now: () => NOW,
    loadAccess: async () => ({ runId: snapshot.run.id, publicId: PUBLIC_ID, workspaceId: snapshot.run.workspaceId, expiresAt: snapshot.run.expiresAt, commandId: REQUEST_ID }),
    loadReport: async () => snapshot,
    loadMatches,
    authorize: async () => ({ user: { id: "controlled-cli", name: "Controlled CLI", email: "" }, workspaceId: snapshot.run.workspaceId }),
  };
}

test("loop result projects a decision-ready 20/20 terminal response", async () => {
  const result = await buildMarketSignalLoopResult({ requestId: REQUEST_ID, report: report(), matches: matchPage(), evaluation: null });
  assert.equal(result.state, "terminal");
  assert.equal(result.output.status, "complete");
  assert.equal(result.output.metrics.publishedComparisons, 20);
  assert.equal(result.output.metrics.pricedComparisons, 20);
  assert.equal(result.output.metrics.costMicrousd, null);
  assert.equal(result.output.report.ownerPath, `/reports/${PUBLIC_ID}`);
  assert.equal(result.decision.headline, "babanuj.com returned 20 priced product comparisons.");
  assert.equal(result.competitors.totalCount, 1);
  assert.deepEqual(result.competitors.items[0], {
    domain: "rival.example",
    name: "Rival Market",
    comparisonCount: 20,
    comparisonSharePercent: 100,
    relationship: "direct substitute",
    confidence: "High",
    reason: "Carries accepted priced alternatives.",
    verificationScore: 91,
    websiteUrl: "https://rival.example/",
  });
  assert.equal(result.comparisons.items.length, 20);
  assert.equal(result.comparisons.returnedCount, 20);
  assert.equal(result.comparisons.items[0].primaryProduct.title, "Babanuj product 1");
  assert.equal(result.comparisons.items[0].rivalProduct.sourceUrl, "https://rival.example/products/1");
  assert.equal(result.comparisons.items[0].priceComparison.position, "rival_lower");
  assert.equal(result.comparisons.items[0].priceComparison.gapPercent, 10);
});

test("loop result fails closed instead of publishing an empty-price comparison", async () => {
  const page = matchPage();
  page.items[0].rival.priceSignals = [];
  page.items[0].match.decision.priceComparison.rivalRaw = "";
  await assert.rejects(
    buildMarketSignalLoopResult({ requestId: REQUEST_ID, report: report(), matches: page, evaluation: null }),
    (error) => error instanceof ReportLoopFactsError && /incomplete rival product facts/i.test(error.message),
  );
});

test("loop result route maps unavailable and inconsistent facts to distinct 409 responses", async () => {
  const unavailableServices = routeServices();
  unavailableServices.loadMatches = async () => { throw new Error("Authoritative report match facts are unavailable."); };
  const unavailable = await getReportLoopResult(new Request(`https://signal.example/api/reports/${PUBLIC_ID}/result?requestId=${REQUEST_ID}`), { params: { publicId: PUBLIC_ID } }, unavailableServices);
  assert.equal(unavailable.status, 409);
  assert.equal((await unavailable.json()).errorCode, "facts-unavailable");

  const inconsistentPage = matchPage();
  inconsistentPage.items[0].rival.priceSignals = [];
  inconsistentPage.items[0].match.decision.priceComparison.rivalRaw = "";
  const inconsistent = await getReportLoopResult(new Request(`https://signal.example/api/reports/${PUBLIC_ID}/result?requestId=${REQUEST_ID}`), { params: { publicId: PUBLIC_ID } }, routeServices(report(), inconsistentPage));
  assert.equal(inconsistent.status, 409);
  assert.equal((await inconsistent.json()).errorCode, "facts-inconsistent");

  const inconsistentSummary = report();
  inconsistentSummary.run.productLimit = 1;
  const contractFailure = await getReportLoopResult(new Request(`https://signal.example/api/reports/${PUBLIC_ID}/result?requestId=${REQUEST_ID}`), { params: { publicId: PUBLIC_ID } }, routeServices(inconsistentSummary, matchPage()));
  assert.equal(contractFailure.status, 409);
  assert.equal((await contractFailure.json()).errorCode, "facts-inconsistent");
});

test("normalized comparison pages preserve report binding and every agent-facing fact", async () => {
  const rawCursor = `rival.example~${String(2).padStart(64, "0")}`;
  const boundCursor = `${PUBLIC_ID}~${rawCursor}`;
  const requested = [];
  const services = comparisonRouteServices(report(), async (_publicId, input) => {
    requested.push(input);
    if (input.cursor) {
      const page = matchPage(3);
      page.items = page.items.slice(2);
      page.nextCursor = null;
      return page;
    }
    const page = matchPage(3);
    page.items = page.items.slice(0, 2);
    page.nextCursor = rawCursor;
    return page;
  });
  const first = await getReportComparisonResult(new Request(`https://signal.example/api/reports/${PUBLIC_ID}/result/comparisons?requestId=${REQUEST_ID}&limit=2`), { params: { publicId: PUBLIC_ID } }, services);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.schemaVersion, "1");
  assert.equal(firstBody.returnedCount, 2);
  assert.equal(firstBody.totalCount, 3);
  assert.equal(firstBody.nextCursor, boundCursor);
  assert.deepEqual(firstBody.items[0].primaryProduct.price, { display: "$10.00", amount: 10, currency: "USD" });
  assert.deepEqual(firstBody.items[0].rivalProduct.price, { display: "$9.00", amount: 9, currency: "USD" });
  assert.equal(firstBody.items[0].match.method, "direct-web-search");
  assert.equal(firstBody.items[0].priceComparison.gapAmount, 1);
  assert.equal(firstBody.items[0].recommendation.action, "Review the verified price gap.");

  const second = await getReportComparisonResult(new Request(`https://signal.example/api/reports/${PUBLIC_ID}/result/comparisons?requestId=${REQUEST_ID}&limit=2&cursor=${encodeURIComponent(boundCursor)}`), { params: { publicId: PUBLIC_ID } }, services);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.returnedCount, 1);
  assert.equal(secondBody.nextCursor, null);
  assert.deepEqual(requested, [{ cursor: undefined, limit: 2 }, { cursor: rawCursor, limit: 2 }]);

  let accessReads = 0;
  const foreignServices = comparisonRouteServices(report());
  foreignServices.loadAccess = async () => { accessReads += 1; return null; };
  const foreignCursor = `${"f".repeat(32)}~${rawCursor}`;
  const foreign = await getReportComparisonResult(new Request(`https://signal.example/api/reports/${PUBLIC_ID}/result/comparisons?requestId=${REQUEST_ID}&cursor=${encodeURIComponent(foreignCursor)}`), { params: { publicId: PUBLIC_ID } }, foreignServices);
  assert.equal(foreign.status, 404);
  assert.equal(accessReads, 0);
});

test("normalized comparison pages reject inconsistent stored facts", async () => {
  const page = matchPage();
  page.items[0].primary.sourceUrl = "https://wrong.example/products/1";
  const response = await getReportComparisonResult(new Request(`https://signal.example/api/reports/${PUBLIC_ID}/result/comparisons?requestId=${REQUEST_ID}`), { params: { publicId: PUBLIC_ID } }, comparisonRouteServices(report(), async () => page));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).errorCode, "facts-inconsistent");
});

test("loop result route binds both report ownership and the original request id", async () => {
  let sensitiveReads = 0;
  const services = routeServices();
  services.loadReport = async () => { sensitiveReads += 1; return report(); };
  const wrong = await getReportLoopResult(new Request(`https://signal.example/api/reports/${PUBLIC_ID}/result?requestId=orchestrator:other:001`), { params: { publicId: PUBLIC_ID } }, services);
  assert.equal(wrong.status, 404);
  assert.equal(sensitiveReads, 0);

  services.authorize = async () => null;
  const foreign = await getReportLoopResult(new Request(`https://signal.example/api/reports/${PUBLIC_ID}/result?requestId=${REQUEST_ID}`), { params: { publicId: PUBLIC_ID } }, services);
  assert.equal(foreign.status, 404);
  assert.equal(sensitiveReads, 0);
});

test("loop result route returns pending without loading terminal facts", async () => {
  const snapshot = report("running");
  const services = routeServices(snapshot, null);
  services.loadMatches = async () => { throw new Error("pending reads must not load match facts"); };
  const response = await getReportLoopResult(new Request(`https://signal.example/api/reports/${PUBLIC_ID}/result?requestId=${REQUEST_ID}`), { params: { publicId: PUBLIC_ID } }, services);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.state, "pending");
  assert.equal(body.requestId, REQUEST_ID);
  assert.equal(body.publicReportId, PUBLIC_ID);
});

test("controlled CLI bearer is accepted only outside hosted billing", async () => {
  const request = new Request("https://controlled.example/api/reports", { headers: { authorization: `Bearer ${TOKEN}` } });
  const controlled = await reportApiAccountContext(request, { MARKET_SIGNAL_HOSTED_BILLING: "false", MARKET_SIGNAL_API_TOKEN: TOKEN });
  assert.equal(controlled?.workspaceId, CONTROLLED_CLI_WORKSPACE_ID);
  assert.equal(await reportApiAccountContext(request, { MARKET_SIGNAL_HOSTED_BILLING: "true", MARKET_SIGNAL_API_TOKEN: TOKEN }), null);
});

test("a replayed queued command without a dispatch record recovers through the idempotent dispatch key", async () => {
  let dispatches = 0;
  let creationInput;
  const created = {
    id: "run_babanuj_001", publicId: PUBLIC_ID, primaryDomain: "babanuj.com", locale: "en", status: "queued", currentPhase: "queued",
    attemptCount: 1, createdAt: NOW.toISOString(), expiresAt: "2026-12-01T10:00:00.000Z", productPlan: "starter", productLimit: 20, productTargetKind: "pairs",
  };
  const result = await createReportCommand({
    primaryDomain: "babanuj.com",
    locale: "en",
    commandId: REQUEST_ID,
    actor: { workspaceId: CONTROLLED_CLI_WORKSPACE_ID, userId: "controlled-cli" },
  }, {
    create: async (input) => { creationInput = input; return { ok: true, replayed: true, dispatchRecorded: false, report: created }; },
    dispatch: async () => { dispatches += 1; return { runId: "run_recovered1", idempotencyKey: `${PUBLIC_ID}:1:1` }; },
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
  });
  assert.deepEqual(creationInput, { primaryDomain: "babanuj.com", locale: "en", workspaceId: CONTROLLED_CLI_WORKSPACE_ID, commandId: REQUEST_ID });
  assert.equal(result.ok, true);
  assert.equal(result.replayed, true);
  assert.deepEqual(result.job, { dispatched: true, runId: "run_recovered1" });
  assert.equal(dispatches, 1);
});

test("a replayed command with a durable dispatch record never dispatches again", async () => {
  let dispatches = 0;
  const created = {
    id: "run_babanuj_001", publicId: PUBLIC_ID, primaryDomain: "babanuj.com", locale: "en", status: "queued", currentPhase: "queued",
    attemptCount: 1, createdAt: NOW.toISOString(), expiresAt: "2026-12-01T10:00:00.000Z", productPlan: "starter", productLimit: 20, productTargetKind: "pairs",
  };
  const result = await createReportCommand({
    primaryDomain: "babanuj.com",
    locale: "en",
    commandId: REQUEST_ID,
    actor: { workspaceId: CONTROLLED_CLI_WORKSPACE_ID, userId: "controlled-cli" },
  }, {
    create: async () => ({ ok: true, replayed: true, dispatchRecorded: true, report: created }),
    dispatch: async () => { dispatches += 1; return { runId: "must-not-run", idempotencyKey: "must-not-run" }; },
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.replayed, true);
  assert.deepEqual(result.job, { dispatched: false, runId: "" });
  assert.equal(dispatches, 0);
});

test("controlled report route echoes and persists the caller command identity", async () => {
  let creationInput;
  let dispatches = 0;
  const created = {
    id: "run_babanuj_001", publicId: PUBLIC_ID, primaryDomain: "babanuj.com", locale: "en", status: "queued", currentPhase: "queued",
    attemptCount: 1, createdAt: NOW.toISOString(), expiresAt: "2026-12-01T10:00:00.000Z", productPlan: "starter", productLimit: 20, productTargetKind: "pairs",
  };
  const response = await createPersistentReport(new Request("https://controlled.example/api/reports", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ primaryDomain: "babanuj.com", locale: "en", commandId: REQUEST_ID }),
  }), {
    requireAccount: false,
    authorizeLoop: async () => ({ user: { id: "controlled-cli", name: "Controlled CLI", email: "" }, workspaceId: CONTROLLED_CLI_WORKSPACE_ID }),
    create: async (input) => { creationInput = input; return { ok: true, replayed: true, dispatchRecorded: true, report: created }; },
    dispatch: async () => { dispatches += 1; return { runId: "must-not-run", idempotencyKey: "must-not-run" }; },
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
  });
  assert.equal(response.status, 202);
  assert.deepEqual(creationInput, { primaryDomain: "babanuj.com", locale: "en", workspaceId: CONTROLLED_CLI_WORKSPACE_ID, commandId: REQUEST_ID });
  assert.deepEqual(await response.json(), {
    ok: true,
    requestId: REQUEST_ID,
    replayed: true,
    report: created,
    job: { dispatched: false, runId: "" },
  });
  assert.equal(dispatches, 0);
});

test("report store replays the same command and rejects changed intent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-loop-command-"));
  const database = await NodeSqliteDatabase.open(join(directory, "reports.sqlite"));
  try {
    const input = { primaryDomain: "babanuj.com", locale: "en", workspaceId: CONTROLLED_CLI_WORKSPACE_ID, commandId: REQUEST_ID };
    const first = await createReportRunResult(input, NOW, database);
    const second = await createReportRunResult(input, NOW, database);
    assert.equal(first.ok, true);
    assert.equal(first.replayed, false);
    assert.equal(first.dispatchRecorded, false);
    assert.equal(second.ok, true);
    assert.equal(second.replayed, true);
    assert.equal(second.dispatchRecorded, false);
    assert.equal(second.report.publicId, first.report.publicId);
    await markReportDispatched(first.report.publicId, "run_recorded1", NOW, database);
    const dispatchedReplay = await createReportRunResult(input, NOW, database);
    assert.equal(dispatchedReplay.ok, true);
    assert.equal(dispatchedReplay.replayed, true);
    assert.equal(dispatchedReplay.dispatchRecorded, true);
    const conflict = await createReportRunResult({ ...input, primaryDomain: "different.example" }, NOW, database);
    assert.deepEqual(conflict, { ok: false, diagnosticCode: "command-intent-conflict" });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
