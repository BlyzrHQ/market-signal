import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getAccountReports } from "../app/api/account/reports/route.ts";
import { NodeSqliteDatabase } from "../app/lib/node-sqlite-database.ts";
import { createReportRun, listWorkspaceReports } from "../app/lib/report-store.ts";

const account = { user: { id: "user-1", name: "Owner", email: "owner@example.test" }, workspaceId: "workspace-owner" };

test("private report history requires authentication and a current paid plan", async () => {
  let listedWorkspace = "";
  const request = new Request("https://signal.example/api/account/reports");
  const anonymous = await getAccountReports(request, {
    enabled: () => true,
    authorize: async () => null,
    activePlan: async () => { throw new Error("must not load billing"); },
    listReports: async () => { throw new Error("must not list reports"); },
  });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("cache-control"), /private/);
  assert.deepEqual((await anonymous.json()).reports, []);

  const unpaid = await getAccountReports(request, {
    enabled: () => true,
    authorize: async () => account,
    activePlan: async () => false,
    listReports: async () => { throw new Error("must not list reports"); },
  });
  assert.equal(unpaid.status, 402);
  assert.deepEqual((await unpaid.json()).reports, []);

  const paid = await getAccountReports(request, {
    enabled: () => true,
    authorize: async () => account,
    activePlan: async () => true,
    listReports: async (workspaceId) => {
      listedWorkspace = workspaceId;
      return [{ publicId: "a".repeat(32), primaryDomain: "owned.example", status: "complete", createdAt: "2026-08-16T10:00:00.000Z", updatedAt: "2026-08-16T10:05:00.000Z" }];
    },
  });
  assert.equal(paid.status, 200);
  assert.equal(listedWorkspace, account.workspaceId);
  assert.deepEqual(await paid.json(), {
    authenticated: true,
    eligible: true,
    reports: [{ publicId: "a".repeat(32), primaryDomain: "owned.example", status: "complete", createdAt: "2026-08-16T10:00:00.000Z", updatedAt: "2026-08-16T10:05:00.000Z" }],
  });
  assert.equal(paid.headers.get("vary"), "Cookie");
});

test("report history is absent when hosted billing is disabled", async () => {
  const response = await getAccountReports(new Request("https://signal.example/api/account/reports"), {
    enabled: () => false,
    authorize: async () => { throw new Error("must not authorize"); },
    activePlan: async () => { throw new Error("must not load billing"); },
    listReports: async () => { throw new Error("must not list reports"); },
  });
  assert.equal(response.status, 404);
  assert.deepEqual((await response.json()).reports, []);
});

test("workspace report history is ordered, bounded, unexpired, and tenant scoped", async () => {
  assert.deepEqual(await listWorkspaceReports("", {}, null), []);
  const directory = await mkdtemp(join(tmpdir(), "market-signal-history-"));
  const database = await NodeSqliteDatabase.open(join(directory, "history.sqlite"));
  try {
    const older = await createReportRun({ primaryDomain: "older.example", workspaceId: "workspace-owner" }, new Date("2026-08-14T09:00:00.000Z"), database);
    const newer = await createReportRun({ primaryDomain: "newer.example", workspaceId: "workspace-owner" }, new Date("2026-08-15T09:00:00.000Z"), database);
    await createReportRun({ primaryDomain: "foreign.example", workspaceId: "workspace-other" }, new Date("2026-08-16T09:00:00.000Z"), database);
    await createReportRun({ primaryDomain: "expired.example", workspaceId: "workspace-owner" }, new Date("2026-06-01T09:00:00.000Z"), database);

    const reports = await listWorkspaceReports("workspace-owner", { limit: 2, now: new Date("2026-08-16T12:00:00.000Z") }, database);
    assert.deepEqual(reports.map((report) => report.publicId), [newer.publicId, older.publicId]);
    assert.deepEqual(reports.map((report) => report.primaryDomain), ["newer.example", "older.example"]);
    assert.equal(reports.some((report) => "workspaceId" in report), false);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
