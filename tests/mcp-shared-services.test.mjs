import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { BILLING_PLANS } from "../app/lib/billing-plans.ts";
import { createReportCommand, publicReportCommandFailure } from "../app/lib/report-command-service.ts";
import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import {
  customerReportPayload,
  getWorkspaceReport,
  getWorkspaceReportMatches,
  listWorkspaceReportSummaries,
  ReportQueryError,
} from "../app/lib/report-query-service.ts";
import {
  createReportRun,
  finalizeReportFactManifest,
  getStoredReport,
  listWorkspaceReports,
  loadStoredReportAccess,
  loadStoredReportMatchPage,
  saveReportDocument,
  saveReportFactChunk,
} from "../app/lib/report-store.ts";
import {
  activateWorkspacePriceWatchers,
  deleteWorkspacePriceWatcher,
  disableWorkspacePriceWatcher,
  getWorkspacePriceWatchHistory,
  listWorkspacePriceWatchers,
} from "../app/lib/price-watch-service.ts";
import { PriceWatchStoreError } from "../app/lib/price-watch-store.ts";
import { buildReportFactBundle } from "../src/shared/report-facts.ts";
import {
  PRICE_WATCH_MATCH_ID,
  PRICE_WATCH_NOW,
  PRICE_WATCH_PUBLIC_ID,
  PRICE_WATCH_USER_ID,
  PRICE_WATCH_WORKSPACE_ID,
  addPriceWatchReport,
  openPriceWatchFixture,
} from "./helpers/price-watch-fixture.mjs";

const PUBLIC_ID = "a".repeat(32);
const NOW = new Date("2026-08-28T08:00:00.000Z");

function createdReport() {
  return {
    id: "run-1",
    publicId: PUBLIC_ID,
    primaryDomain: "owned.example",
    locale: "en",
    status: "queued",
    currentPhase: "queued",
    attemptCount: 1,
    createdAt: NOW.toISOString(),
    expiresAt: "2026-11-28T08:00:00.000Z",
    productPlan: "starter",
    productLimit: 20,
  };
}

function reportCommandServices(overrides = {}) {
  return {
    reserve: async () => ({ id: "reservation-1", plan: BILLING_PLANS.starter, used: 1, limit: 5 }),
    finishReservation: async () => {},
    create: async () => ({ ok: true, report: createdReport() }),
    dispatch: async () => ({ runId: "trigger-1", idempotencyKey: `${PUBLIC_ID}:6:1` }),
    markDispatched: async () => {},
    markDispatchFailed: async () => {},
    ...overrides,
  };
}

test("shared report creation keeps server-owned entitlement inputs and leaves successful reservations for terminal settlement", async () => {
  let creationInput;
  const settlements = [];
  const result = await createReportCommand({
    primaryDomain: "owned.example",
    locale: "en",
    actor: { workspaceId: "workspace-owner", userId: "user-owner" },
  }, reportCommandServices({
    create: async (input) => { creationInput = input; return { ok: true, report: createdReport() }; },
    finishReservation: async (...input) => settlements.push(input),
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(creationInput, {
    primaryDomain: "owned.example",
    locale: "en",
    workspaceId: "workspace-owner",
    billingReservationId: "reservation-1",
    entitlement: { plan: "starter", productLimit: 20 },
  });
  assert.deepEqual(settlements, []);
});

test("shared report creation releases the exact reservation on storage and dispatch failure", async () => {
  for (const stage of ["storage", "dispatch"]) {
    const settlements = [];
    const marked = [];
    const result = await createReportCommand({
      primaryDomain: "owned.example",
      locale: "en",
      actor: { workspaceId: "workspace-owner", userId: "user-owner" },
    }, reportCommandServices({
      create: async () => stage === "storage" ? { ok: false, diagnosticCode: "storage-unavailable" } : { ok: true, report: createdReport() },
      dispatch: async () => { throw new Error("private upstream detail"); },
      markDispatchFailed: async (publicId) => marked.push(publicId),
      finishReservation: async (...input) => settlements.push(input),
    }));

    assert.equal(result.ok, false);
    assert.deepEqual(settlements, [["reservation-1", "released"]]);
    assert.deepEqual(marked, stage === "dispatch" ? [PUBLIC_ID] : []);
    assert.doesNotMatch(JSON.stringify(result), /private upstream detail/);
    const publicFailure = publicReportCommandFailure(result);
    assert.equal("status" in publicFailure, false);
    assert.equal("diagnosticCode" in publicFailure, false);
    assert.equal("stage" in publicFailure, false);
  }
});

async function persistEmptyCompleteReport(database, created) {
  const comparison = {
    primaryDomain: created.primaryDomain,
    comparisonDomains: [],
    rows: [],
    unmatched: [],
    coverage: {
      primaryProductsAvailable: 0,
      primaryProductsScanned: 0,
      primaryProductFamiliesCompared: 0,
      competitorProductsAvailable: 0,
      competitorProductsScanned: 0,
      assignedPairCount: 0,
      verifiedPairCount: 0,
      rowsReturned: 0,
      rowLimit: 20,
      truncated: false,
    },
    matching: { primaryProductsAssessed: 0 },
  };
  const bundle = await buildReportFactBundle({
    publicId: created.publicId,
    crawlResults: [{
      domain: created.primaryDomain,
      role: "primary",
      homepage: { sourceUrl: `https://${created.primaryDomain}/`, title: "Owned shop" },
      products: [],
      fetchedAt: NOW.toISOString(),
    }],
    comparison,
    adBlock: null,
    observedAt: NOW.toISOString(),
  });
  for (const chunk of bundle.chunks) await saveReportFactChunk(created.publicId, chunk, NOW, database);
  await finalizeReportFactManifest(created.publicId, bundle.manifest, NOW, database);
  await saveReportDocument(
    created.publicId,
    { blocks: [{ type: "product-comparison", id: "products", ...comparison }] },
    { status: "complete", expectedFactManifestHash: bundle.manifest.manifestHash },
    NOW,
    database,
  );
}

function storedSnapshot(workspaceId = "workspace-owner") {
  return {
    run: {
      id: "run-1",
      publicId: PUBLIC_ID,
      primaryDomain: "owned.example",
      locale: "en",
      status: "complete",
      currentPhase: "complete",
      attemptCount: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      heartbeatAt: NOW.toISOString(),
      expiresAt: "2026-11-28T08:00:00.000Z",
      errorCode: "",
      errorMessage: "",
      workspaceId,
      billingReservationId: "reservation-1",
      productPlan: "starter",
      productLimit: 20,
      productTargetKind: "pairs",
    },
    events: [],
    document: { document: { blocks: [] } },
    documentSchemaVersion: 1,
    documentObservedAt: NOW.toISOString(),
  };
}

function reportQueryServices(workspaceId = "workspace-owner") {
  return {
    now: () => NOW,
    listReports: async (requestedWorkspace, input) => [{ publicId: PUBLIC_ID, primaryDomain: requestedWorkspace, status: "complete", createdAt: input.now.toISOString(), updatedAt: input.now.toISOString() }],
    loadAccess: async () => ({ runId: "run-1", publicId: PUBLIC_ID, workspaceId, expiresAt: "2026-11-28T08:00:00.000Z" }),
    loadReport: async () => storedSnapshot(workspaceId),
    loadMatchPage: async () => ({ authoritative: true, manifestHash: "f".repeat(64), totalCount: 1, directPriceCount: 1, domainCounts: { "rival.example": 1 }, items: [], nextCursor: null }),
    settle: async () => true,
  };
}

test("shared report queries redact internal fields and authorize before report or match reads", async () => {
  const calls = [];
  const ownedServices = reportQueryServices();
  ownedServices.loadReport = async () => { calls.push("report"); return storedSnapshot(); };
  ownedServices.loadMatchPage = async () => { calls.push("matches"); return reportQueryServices().loadMatchPage(); };
  ownedServices.settle = async () => { calls.push("settle"); return true; };

  const report = await getWorkspaceReport("workspace-owner", PUBLIC_ID, ownedServices);
  assert.deepEqual(report, customerReportPayload(storedSnapshot()));
  assert.equal("workspaceId" in report.run, false);
  assert.equal("billingReservationId" in report.run, false);
  await getWorkspaceReportMatches("workspace-owner", PUBLIC_ID, {}, ownedServices);
  assert.deepEqual(calls, ["report", "settle", "matches"]);

  let sensitiveReads = 0;
  const foreignServices = reportQueryServices("workspace-other");
  foreignServices.loadReport = async () => { sensitiveReads += 1; return storedSnapshot("workspace-other"); };
  foreignServices.loadMatchPage = async () => { sensitiveReads += 1; return reportQueryServices().loadMatchPage(); };
  await assert.rejects(() => getWorkspaceReport("workspace-owner", PUBLIC_ID, foreignServices), (error) => error instanceof ReportQueryError && error.code === "not-found");
  await assert.rejects(() => getWorkspaceReportMatches("workspace-owner", PUBLIC_ID, {}, foreignServices), (error) => error instanceof ReportQueryError && error.code === "not-found");
  assert.equal(sensitiveReads, 0);
});

test("shared report queries enforce tenancy and redaction through the real report store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-report-query-service-"));
  const database = await NodeSqliteDatabase.open(join(directory, "reports.sqlite"));
  try {
    const owned = await createReportRun({
      primaryDomain: "owned.example",
      workspaceId: "workspace-owner",
      billingReservationId: "reservation-secret",
    }, NOW, database);
    const foreign = await createReportRun({
      primaryDomain: "foreign.example",
      workspaceId: "workspace-foreign",
      billingReservationId: "foreign-reservation-secret",
    }, NOW, database);
    await persistEmptyCompleteReport(database, owned);

    let settledRun;
    const services = {
      now: () => NOW,
      listReports: (workspaceId, input) => listWorkspaceReports(workspaceId, input, database),
      loadAccess: (publicId) => loadStoredReportAccess(publicId, database),
      loadReport: (publicId, now) => getStoredReport(publicId, now, database),
      loadMatchPage: (publicId, input) => loadStoredReportMatchPage(publicId, input, database),
      settle: async (run) => { settledRun = run; return true; },
    };

    const report = await getWorkspaceReport("workspace-owner", owned.publicId, services);
    assert.equal(report.run.primaryDomain, "owned.example");
    assert.equal("workspaceId" in report.run, false);
    assert.equal("billingReservationId" in report.run, false);
    assert.equal(settledRun.billingReservationId, "reservation-secret");

    const matches = await getWorkspaceReportMatches("workspace-owner", owned.publicId, { limit: 20 }, services);
    assert.equal(matches.authoritative, true);
    assert.equal(matches.totalCount, 0);

    let sensitiveReads = 0;
    const guardedServices = {
      ...services,
      loadReport: async (...input) => { sensitiveReads += 1; return getStoredReport(...input, database); },
      loadMatchPage: async (...input) => { sensitiveReads += 1; return loadStoredReportMatchPage(...input, database); },
    };
    await assert.rejects(
      () => getWorkspaceReport("workspace-owner", foreign.publicId, guardedServices),
      (error) => error instanceof ReportQueryError && error.code === "not-found",
    );
    await assert.rejects(
      () => getWorkspaceReportMatches("workspace-owner", foreign.publicId, {}, guardedServices),
      (error) => error instanceof ReportQueryError && error.code === "not-found",
    );
    assert.equal(sensitiveReads, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared report summary queries bind server time and the requested workspace", async () => {
  let captured;
  const services = reportQueryServices();
  services.listReports = async (...input) => { captured = input; return []; };
  assert.deepEqual(await listWorkspaceReportSummaries("workspace-owner", { limit: 5 }, services), []);
  assert.deepEqual(captured, ["workspace-owner", { limit: 5, now: NOW }]);
  assert.deepEqual(await listWorkspaceReportSummaries("", { limit: 5 }, services), []);
});

function priceWatchFixture() {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-shared-service-"));
  const path = join(directory, "fixture.sqlite");
  const database = openPriceWatchFixture(path);
  addPriceWatchReport(database);
  database.close();
  return {
    directory,
    path,
    services: { openDatabase: async () => openPriceWatchFixture(path), now: () => PRICE_WATCH_NOW },
  };
}

test("shared price-watch services preserve workspace ownership across lifecycle operations", async () => {
  const fixture = priceWatchFixture();
  try {
    const actor = { workspaceId: PRICE_WATCH_WORKSPACE_ID, userId: PRICE_WATCH_USER_ID };
    const activation = await activateWorkspacePriceWatchers(actor, {
      publicReportId: PRICE_WATCH_PUBLIC_ID,
      matchId: PRICE_WATCH_MATCH_ID,
      cadence: "daily",
    }, fixture.services);
    const watcherId = activation.watcherIds[0];
    assert.equal((await listWorkspacePriceWatchers(actor.workspaceId, fixture.services)).watchers.length, 1);
    assert.equal((await listWorkspacePriceWatchers("workspace-other", fixture.services)).watchers.length, 0);
    await assert.rejects(
      () => getWorkspacePriceWatchHistory("workspace-other", watcherId, 100, fixture.services),
      (error) => error instanceof PriceWatchStoreError && error.code === "watcher-not-found",
    );
    const disabled = await disableWorkspacePriceWatcher(actor, watcherId, fixture.services);
    assert.equal(disabled.watcher.state, "disabled");
    assert.equal(await deleteWorkspacePriceWatcher(actor, watcherId, fixture.services), true);
    assert.equal((await listWorkspacePriceWatchers(actor.workspaceId, fixture.services)).watchers.length, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
