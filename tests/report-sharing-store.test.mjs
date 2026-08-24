import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import {
  ensureReportSharingSchema,
  getReportShareState,
  ReportShareStoreError,
  resolveActiveReportShare,
  shareReport,
  unshareReport,
} from "../app/lib/report-sharing-store.ts";

const now = new Date("2026-08-24T12:00:00.000Z");
const future = "2026-09-24T00:00:00.000Z";
const tokenA = "a".repeat(64);
const tokenB = "b".repeat(64);

function database() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE report_runs (
      id text PRIMARY KEY NOT NULL,
      public_id text NOT NULL UNIQUE,
      workspace_id text NOT NULL,
      status text NOT NULL,
      expires_at text NOT NULL
    );
    CREATE TABLE report_documents (
      run_id text PRIMARY KEY NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE
    );
  `);
  ensureReportSharingSchema(db);
  return db;
}

function insertReport(db, { runId = "run-1", publicId = "1".repeat(32), workspaceId = "workspace-1", status = "complete", expiresAt = future, document = true } = {}) {
  db.prepare("INSERT INTO report_runs (id, public_id, workspace_id, status, expires_at) VALUES (?, ?, ?, ?, ?)").run(runId, publicId, workspaceId, status, expiresAt);
  if (document) db.prepare("INSERT INTO report_documents (run_id) VALUES (?)").run(runId);
  return { runId, publicId, workspaceId };
}

test("reports are private until sharing creates an idempotent 256-bit capability", () => {
  const db = database();
  const report = insertReport(db);
  assert.deepEqual(getReportShareState(db, report.publicId, report.workspaceId, now), { shared: false, token: "", rotation: 0, sharedAt: "", revokedAt: "" });

  const first = shareReport(db, report.publicId, report.workspaceId, "user-1", now, () => tokenA);
  assert.equal(first.shared, true);
  assert.equal(first.token, tokenA);
  assert.equal(first.rotation, 1);
  assert.deepEqual(resolveActiveReportShare(db, tokenA, now), { runId: report.runId, privatePublicId: report.publicId });

  const replay = shareReport(db, report.publicId, report.workspaceId, "user-1", new Date("2026-08-24T12:05:00.000Z"), () => tokenB);
  assert.equal(replay.token, tokenA);
  assert.equal(replay.rotation, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM report_share_audits").get().count, 1);
  db.close();
});

test("unsharing revokes immediately and re-sharing rotates without preserving the old token", () => {
  const db = database();
  const report = insertReport(db);
  shareReport(db, report.publicId, report.workspaceId, "user-1", now, () => tokenA);
  const revoked = unshareReport(db, report.publicId, report.workspaceId, "user-1", new Date("2026-08-24T12:10:00.000Z"));
  assert.equal(revoked.shared, false);
  assert.equal(revoked.token, "");
  assert.equal(resolveActiveReportShare(db, tokenA, now), null);

  const reshared = shareReport(db, report.publicId, report.workspaceId, "user-1", new Date("2026-08-24T12:20:00.000Z"), () => tokenB);
  assert.equal(reshared.token, tokenB);
  assert.equal(reshared.rotation, 2);
  assert.equal(resolveActiveReportShare(db, tokenA, now), null);
  assert.deepEqual(resolveActiveReportShare(db, tokenB, now), { runId: report.runId, privatePublicId: report.publicId });
  assert.deepEqual(db.prepare("SELECT action, rotation FROM report_share_audits ORDER BY created_at").all(), [
    { action: "share", rotation: 1 },
    { action: "unshare", rotation: 1 },
    { action: "share", rotation: 2 },
  ]);
  db.close();
});

test("share eligibility fails closed for other workspaces, unfinished, missing, and expired reports", () => {
  const db = database();
  const complete = insertReport(db);
  const pending = insertReport(db, { runId: "run-2", publicId: "2".repeat(32), status: "running" });
  const missingDocument = insertReport(db, { runId: "run-3", publicId: "3".repeat(32), document: false });
  const expired = insertReport(db, { runId: "run-4", publicId: "4".repeat(32), expiresAt: "2026-08-24T11:59:59.000Z" });

  assert.throws(() => shareReport(db, complete.publicId, "workspace-other", "user-2", now, () => tokenA), (error) => error instanceof ReportShareStoreError && error.code === "not-found" && error.httpStatus === 404);
  for (const report of [pending, missingDocument]) {
    assert.throws(() => shareReport(db, report.publicId, report.workspaceId, "user-1", now, () => tokenA), (error) => error instanceof ReportShareStoreError && error.code === "report-not-shareable" && error.httpStatus === 409);
  }
  assert.throws(() => shareReport(db, expired.publicId, expired.workspaceId, "user-1", now, () => tokenA), (error) => error instanceof ReportShareStoreError && error.code === "not-found");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM report_share_links").get().count, 0);
  db.close();
});

test("audits never contain tokens, reject mutation, and still cascade during report retention", () => {
  const db = database();
  const report = insertReport(db);
  shareReport(db, report.publicId, report.workspaceId, "user-1", now, () => tokenA);
  const audit = db.prepare("SELECT * FROM report_share_audits").get();
  assert.equal(Object.hasOwn(audit, "token"), false);
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(tokenA));
  assert.throws(() => db.prepare("UPDATE report_share_audits SET action = 'unshare'").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM report_share_audits").run(), /immutable/);
  db.prepare("DELETE FROM report_runs WHERE id = ?").run(report.runId);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM report_share_audits").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM report_share_links").get().count, 0);
  db.close();
});
