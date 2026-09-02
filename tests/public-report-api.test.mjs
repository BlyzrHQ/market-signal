import assert from "node:assert/strict";
import test from "node:test";

import { getReportResponse, publicReportPayload } from "../app/api/reports/[publicId]/route.ts";

const publicId = "a".repeat(32);
const future = "2026-09-24T00:00:00.000Z";

function storedReport(workspaceId = "workspace-1", expiresAt = future) {
  return {
    run: { id: "run-1", publicId, workspaceId, billingReservationId: "reservation-secret", expiresAt, status: "complete" },
    events: [],
    document: {},
  };
}

function dependencies(overrides = {}) {
  const report = storedReport();
  return {
    now: () => new Date("2026-08-24T12:00:00.000Z"),
    loadAccess: async () => ({ runId: report.run.id, publicId, workspaceId: report.run.workspaceId, expiresAt: report.run.expiresAt }),
    loadReport: async () => report,
    recover: async () => null,
    authorize: async () => ({ user: { id: "user-1", name: "Owner", email: "owner@example.com" }, workspaceId: "workspace-1" }),
    settle: async () => {},
    allowLegacyPublic: () => true,
    ...overrides,
  };
}

test("public reports omit internal workspace and billing reservation identifiers", () => {
  const report = publicReportPayload({
    run: { id: "run-1", publicId, workspaceId: "workspace-secret", billingReservationId: "reservation-secret", status: "running" },
    events: [],
  });
  assert.equal(Object.hasOwn(report.run, "workspaceId"), false);
  assert.equal(Object.hasOwn(report.run, "billingReservationId"), false);
  assert.equal(report.run.publicId, publicId);
});

test("owned reports authorize before reading or settling and use private cache headers", async () => {
  let reads = 0;
  let settles = 0;
  const response = await getReportResponse(
    new Request(`https://signal.example/api/reports/${publicId}`),
    { params: { publicId } },
    dependencies({ loadReport: async () => { reads += 1; return storedReport(); }, settle: async () => { settles += 1; } }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Cookie, Authorization");
  assert.equal(reads, 1);
  assert.equal(settles, 1);
  const body = await response.json();
  assert.equal(Object.hasOwn(body.report.run, "workspaceId"), false);
});

test("non-members receive a non-enumerating 404 before report read or billing settlement", async () => {
  let reads = 0;
  let settles = 0;
  const response = await getReportResponse(
    new Request(`https://signal.example/api/reports/${publicId}`),
    { params: { publicId } },
    dependencies({
      authorize: async () => ({ user: { id: "user-2", name: "Other", email: "other@example.com" }, workspaceId: "workspace-2" }),
      loadReport: async () => { reads += 1; return storedReport(); },
      settle: async () => { settles += 1; },
    }),
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(reads, 0);
  assert.equal(settles, 0);
});

test("unowned legacy reports remain public only before their existing expiry", async () => {
  const legacy = storedReport("", future);
  const response = await getReportResponse(
    new Request(`https://signal.example/api/reports/${publicId}`),
    { params: { publicId } },
    dependencies({
      loadAccess: async () => ({ runId: legacy.run.id, publicId, workspaceId: "", expiresAt: future }),
      loadReport: async () => legacy,
      authorize: async () => { throw new Error("legacy access must not invoke account auth"); },
    }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /^public/);

  const expired = await getReportResponse(
    new Request(`https://signal.example/api/reports/${publicId}`),
    { params: { publicId } },
    dependencies({ loadAccess: async () => ({ runId: legacy.run.id, publicId, workspaceId: "", expiresAt: "2026-08-24T11:59:59.000Z" }) }),
  );
  assert.equal(expired.status, 404);
});

test("hosted deployments do not expose legacy unowned report ids", async () => {
  let reads = 0;
  const response = await getReportResponse(
    new Request(`https://signal.example/api/reports/${publicId}`),
    { params: { publicId } },
    dependencies({
      loadAccess: async () => ({ runId: "run-legacy", publicId, workspaceId: "", expiresAt: future }),
      allowLegacyPublic: () => false,
      loadReport: async () => { reads += 1; return storedReport("", future); },
    }),
  );
  assert.equal(response.status, 404);
  assert.equal(reads, 0);
});
