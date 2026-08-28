import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { reserveReport } from "../app/lib/billing-store.ts";
import { claimMcpConfirmation } from "../app/lib/mcp-command-store.ts";
import { activatePriceWatchers } from "../app/lib/price-watch-store.ts";
import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { createReportRun } from "../app/lib/report-store.ts";
import {
  confirmMcpReportCreate,
  confirmMcpPriceWatchActivation,
  confirmMcpPriceWatchDelete,
  confirmMcpPriceWatchUpdate,
  disableMcpPriceWatch,
  getMcpAccountStatus,
  previewMcpPriceWatchActivation,
  previewMcpPriceWatchDelete,
  previewMcpPriceWatchUpdate,
  previewMcpReportCreate,
} from "../app/lib/mcp-write-service.ts";
import {
  addPriceWatchReport,
  openPriceWatchFixture,
  PRICE_WATCH_MATCH_ID,
  PRICE_WATCH_NOW,
  PRICE_WATCH_PUBLIC_ID,
} from "./helpers/price-watch-fixture.mjs";

const PRINCIPAL = { workspaceId: "workspace-1", userId: "user-1", clientId: "https://client.example/mcp.json" };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-mcp-write-"));
  const path = join(directory, "market-signal.sqlite");
  const initial = openPriceWatchFixture(path);
  addPriceWatchReport(initial);
  initial.close();
  let createCalls = 0;
  const services = {
    openDatabase: async () => {
      const database = new Database(path);
      database.pragma("foreign_keys = ON");
      return database;
    },
    now: () => PRICE_WATCH_NOW,
    createReport: async (input) => {
      createCalls += 1;
      assert.equal(input.commandId.length, 36);
      return {
        ok: true,
        report: {
          id: "run-1",
          publicId: "a".repeat(32),
          primaryDomain: input.primaryDomain,
          locale: input.locale,
          status: "queued",
          currentPhase: "queued",
          attemptCount: 1,
          createdAt: PRICE_WATCH_NOW.toISOString(),
          expiresAt: "2026-11-26T12:00:00.000Z",
          productPlan: "starter",
          productLimit: 20,
          productTargetKind: "pairs",
        },
        job: { dispatched: true, runId: "trigger-run-1" },
      };
    },
  };
  return { directory, path, services, createCalls: () => createCalls };
}

test("account status is field-filtered by granted scope families", async () => {
  const item = fixture();
  try {
    const reports = await getMcpAccountStatus(PRINCIPAL, ["reports:read"], item.services);
    assert.equal(reports.subscription.plan.tier, "starter");
    assert.equal(reports.reports.limit, 5);
    assert.equal("monitoring" in reports, false);

    const monitoring = await getMcpAccountStatus(PRINCIPAL, ["price_watch:write"], item.services);
    assert.equal(monitoring.monitoring.allocation, 1_000);
    assert.equal("reports" in monitoring, false);
    assert.doesNotMatch(JSON.stringify(monitoring), /workspace-1|user-1|cus_|sub_/);
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("report preview reserves nothing and same-token confirm replays one terminal dispatch", async () => {
  const item = fixture();
  try {
    const preview = await previewMcpReportCreate(PRINCIPAL, { primaryDomain: "https://Shop.Example/products", locale: "en" }, item.services);
    assert.equal(preview.impact.primaryDomain, "shop.example");
    assert.equal(preview.impact.reports.used, 0);
    const before = await item.services.openDatabase();
    assert.equal(before.prepare(`SELECT COUNT(*) AS count FROM billing_report_reservations`).get().count, 0);
    assert.equal(before.prepare(`SELECT length(token_hash) AS length FROM mcp_confirmation_intents`).get().length, 64);
    before.close();

    const created = await confirmMcpReportCreate(PRINCIPAL, preview.confirmationToken, item.services);
    assert.equal(created.ok, true);
    assert.equal(created.report.publicReportId, "a".repeat(32));
    assert.equal(item.createCalls(), 1);

    const replay = await confirmMcpReportCreate(PRINCIPAL, preview.confirmationToken, item.services);
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(item.createCalls(), 1);
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("report confirm rejects a material quota-impact change and never dispatches", async () => {
  const item = fixture();
  try {
    const preview = await previewMcpReportCreate(PRINCIPAL, { primaryDomain: "shop.example", locale: "ar" }, item.services);
    const database = await item.services.openDatabase();
    reserveReport(database, PRINCIPAL.workspaceId, PRICE_WATCH_NOW);
    database.close();

    const result = await confirmMcpReportCreate(PRINCIPAL, preview.confirmationToken, item.services);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "impact-changed");
    assert.equal(item.createCalls(), 0);
    const replay = await confirmMcpReportCreate(PRINCIPAL, preview.confirmationToken, item.services);
    assert.equal(replay.error.code, "impact-changed");
    assert.equal(replay.replayed, true);
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("racing the same report token starts one command and exposes in-progress replay", async () => {
  const item = fixture();
  try {
    const originalCreate = item.services.createReport;
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    item.services.createReport = async (input) => {
      entered();
      await gate;
      return originalCreate(input);
    };
    const preview = await previewMcpReportCreate(PRINCIPAL, { primaryDomain: "race.example", locale: "en" }, item.services);
    const first = confirmMcpReportCreate(PRINCIPAL, preview.confirmationToken, item.services);
    await started;
    const concurrent = await confirmMcpReportCreate(PRINCIPAL, preview.confirmationToken, item.services);
    assert.equal(concurrent.status, "in_progress");
    assert.equal(concurrent.replayed, true);
    release();
    assert.equal((await first).ok, true);
    assert.equal(item.createCalls(), 1);
    assert.equal((await confirmMcpReportCreate(PRINCIPAL, preview.confirmationToken, item.services)).replayed, true);
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("an expired report confirmation resumes one durable command after quota was already reserved", async () => {
  const item = fixture();
  try {
    const preview = await previewMcpReportCreate(PRINCIPAL, { primaryDomain: "recover.example", locale: "en" }, item.services);
    const database = await item.services.openDatabase();
    const claim = claimMcpConfirmation(database, PRINCIPAL, "report_create_confirm", preview.confirmationToken, PRICE_WATCH_NOW);
    assert.equal(claim.kind, "claimed");
    const reservation = reserveReport(database, PRINCIPAL.workspaceId, PRICE_WATCH_NOW, claim.commandId);
    assert.ok(reservation.id);
    database.close();

    const recoveryServices = { ...item.services, now: () => new Date(PRICE_WATCH_NOW.getTime() + 301_000) };
    const recovered = await confirmMcpReportCreate(PRINCIPAL, preview.confirmationToken, recoveryServices);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.report.publicReportId, "a".repeat(32));
    assert.equal(item.createCalls(), 1);
    const check = await item.services.openDatabase();
    assert.equal(check.prepare(`SELECT COUNT(*) AS count FROM billing_report_reservations WHERE command_id = ?`).get(claim.commandId).count, 1);
    check.close();
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("report reservations reuse one durable command identity", () => {
  const database = openPriceWatchFixture(":memory:");
  try {
    const first = reserveReport(database, PRINCIPAL.workspaceId, PRICE_WATCH_NOW, "command:one");
    const second = reserveReport(database, PRINCIPAL.workspaceId, PRICE_WATCH_NOW, "command:one");
    assert.equal(first.id, second.id);
    assert.equal(second.used, 1);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM billing_report_reservations`).get().count, 1);
  } finally {
    database.close();
  }
});

test("report storage replays one report row for a durable MCP command identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-mcp-report-command-"));
  const database = await NodeSqliteDatabase.open(join(directory, "reports.sqlite"));
  try {
    const input = { primaryDomain: "shop.example", workspaceId: PRINCIPAL.workspaceId, billingReservationId: "reservation-1", commandId: "command:report-one" };
    const first = await createReportRun(input, PRICE_WATCH_NOW, database);
    const replay = await createReportRun(input, new Date(PRICE_WATCH_NOW.getTime() + 1_000), database);
    assert.equal(replay.id, first.id);
    assert.equal(replay.publicId, first.publicId);
    assert.equal(replay.createdAt, first.createdAt);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("price-watch preview, activation, update, disable, and permanent deletion are replay-safe", async () => {
  const item = fixture();
  try {
    const preview = await previewMcpPriceWatchActivation(PRINCIPAL, {
      publicReportId: PRICE_WATCH_PUBLIC_ID,
      matchId: PRICE_WATCH_MATCH_ID,
      cadence: "daily",
    }, item.services);
    assert.equal(preview.impact.eligibleComparisons, 1);
    assert.equal(preview.impact.baselineCreditsRequired, 1);
    const before = await item.services.openDatabase();
    assert.equal(before.prepare(`SELECT COUNT(*) AS count FROM price_watchers`).get().count, 0);
    assert.equal(before.prepare(`SELECT COUNT(*) AS count FROM price_watch_credit_reservations`).get().count, 0);
    before.close();

    const activated = await confirmMcpPriceWatchActivation(PRINCIPAL, preview.confirmationToken, item.services);
    assert.equal(activated.ok, true);
    assert.equal(activated.created, 1);
    assert.equal(activated.baselineCreditsReserved, 1);
    const watcherId = activated.watcherIds[0];
    const activationReplay = await confirmMcpPriceWatchActivation(PRINCIPAL, preview.confirmationToken, item.services);
    assert.equal(activationReplay.replayed, true);
    const afterReplay = await item.services.openDatabase();
    assert.equal(afterReplay.prepare(`SELECT COUNT(*) AS count FROM price_watchers`).get().count, 1);
    assert.equal(afterReplay.prepare(`SELECT COUNT(*) AS count FROM price_watch_credit_reservations WHERE status = 'reserved'`).get().count, 1);
    afterReplay.close();

    const updatePreview = await previewMcpPriceWatchUpdate(PRINCIPAL, { watcherId, cadence: "hourly" }, item.services);
    assert.equal(updatePreview.impact.usageAfter.projectedDaily, 24);
    const updated = await confirmMcpPriceWatchUpdate(PRINCIPAL, updatePreview.confirmationToken, item.services);
    assert.equal(updated.watcher.cadence, "hourly");
    assert.equal("workspaceId" in updated.watcher, false);

    const disabled = await disableMcpPriceWatch(PRINCIPAL, watcherId, item.services);
    assert.equal(disabled.watcher.state, "disabled");
    assert.equal(disabled.usage.used, 0, "an unused baseline reservation is released when disabled");

    const deletePreview = await previewMcpPriceWatchDelete(PRINCIPAL, watcherId, item.services);
    assert.equal(deletePreview.impact.removes.reportLinks, 1);
    assert.match(deletePreview.message, /Consumed credits remain charged/);
    const deleted = await confirmMcpPriceWatchDelete(PRINCIPAL, deletePreview.confirmationToken, item.services);
    assert.equal(deleted.deleted, true);
    const deleteReplay = await confirmMcpPriceWatchDelete(PRINCIPAL, deletePreview.confirmationToken, item.services);
    assert.equal(deleteReplay.deleted, true);
    assert.equal(deleteReplay.replayed, true);
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("an expired price-watch confirmation reconciles its atomic command receipt after a lost response", async () => {
  const item = fixture();
  try {
    const input = { publicReportId: PRICE_WATCH_PUBLIC_ID, matchId: PRICE_WATCH_MATCH_ID, cadence: "daily" };
    const preview = await previewMcpPriceWatchActivation(PRINCIPAL, input, item.services);
    const database = await item.services.openDatabase();
    const claim = claimMcpConfirmation(database, PRINCIPAL, "price_watch_confirm", preview.confirmationToken, PRICE_WATCH_NOW);
    assert.equal(claim.kind, "claimed");
    activatePriceWatchers(database, PRINCIPAL.workspaceId, PRINCIPAL.userId, input, PRICE_WATCH_NOW, {
      commandId: claim.commandId,
      operation: "price_watch.activate",
      expectedImpactFingerprint: claim.impact.impactFingerprint,
    });
    database.close();

    const recoveryServices = { ...item.services, now: () => new Date(PRICE_WATCH_NOW.getTime() + 301_000) };
    const recovered = await confirmMcpPriceWatchActivation(PRINCIPAL, preview.confirmationToken, recoveryServices);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.created, 1);
    const check = await item.services.openDatabase();
    assert.equal(check.prepare(`SELECT COUNT(*) AS count FROM price_watchers`).get().count, 1);
    assert.equal(check.prepare(`SELECT COUNT(*) AS count FROM price_watch_credit_reservations`).get().count, 1);
    check.close();
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});
