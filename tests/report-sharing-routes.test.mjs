import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { getReportSharing, updateReportSharing } from "../app/api/reports/[publicId]/sharing/route.ts";
import { getSharedReport, sharedReportPayload } from "../app/api/shared-reports/[token]/route.ts";
import { getSharedReportMatches } from "../app/api/shared-reports/[token]/matches/route.ts";
import { ensureReportSharingSchema } from "../app/lib/report-sharing-store.ts";

const publicId = "1".repeat(32);
const token = "a".repeat(64);
const now = new Date("2026-08-24T12:00:00.000Z");
const access = { runId: "run-1", publicId, workspaceId: "workspace-1", expiresAt: "2026-09-24T00:00:00.000Z" };
const owner = { user: { id: "user-1", name: "Owner", email: "owner@example.com" }, workspaceId: "workspace-1" };

function sharingDatabase() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE report_runs (id text PRIMARY KEY, public_id text UNIQUE NOT NULL, workspace_id text NOT NULL, status text NOT NULL, expires_at text NOT NULL);
    CREATE TABLE report_documents (run_id text PRIMARY KEY REFERENCES report_runs(id) ON DELETE CASCADE);
    INSERT INTO report_runs VALUES ('run-1', '${publicId}', 'workspace-1', 'complete', '2026-09-24T00:00:00.000Z');
    INSERT INTO report_documents VALUES ('run-1');
  `);
  ensureReportSharingSchema(db);
  const close = db.close.bind(db);
  Object.defineProperty(db, "close", { value() {}, configurable: true });
  return { db, close };
}

function sharingDependencies(db, overrides = {}) {
  return {
    enabled: () => true,
    authorize: async () => owner,
    loadAccess: async () => access,
    openDatabase: async () => db,
    now: () => now,
    ...overrides,
  };
}

test("owner sharing route is private, same-origin, idempotent, and revocable", async () => {
  const { db, close } = sharingDatabase();
  const services = sharingDependencies(db);
  const initial = await getReportSharing(new Request(`https://signal.example/api/reports/${publicId}/sharing`), { params: { publicId } }, services);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "private, no-store");
  assert.equal((await initial.json()).shared, false);

  const share = await updateReportSharing(new Request(`https://signal.example/api/reports/${publicId}/sharing`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ action: "share" }),
  }), { params: { publicId } }, services);
  assert.equal(share.status, 200);
  const shared = await share.json();
  assert.equal(shared.shared, true);
  assert.match(shared.publicUrl, /^https:\/\/signal\.example\/shared\/[a-f0-9]{64}$/);
  assert.doesNotMatch(shared.publicUrl, new RegExp(publicId));

  const replay = await updateReportSharing(new Request(`https://signal.example/api/reports/${publicId}/sharing`, {
    method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ action: "share" }),
  }), { params: { publicId } }, services);
  assert.equal((await replay.json()).publicUrl, shared.publicUrl);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM report_share_audits").get().count, 1);

  const revoke = await updateReportSharing(new Request(`https://signal.example/api/reports/${publicId}/sharing`, {
    method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ action: "unshare" }),
  }), { params: { publicId } }, services);
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).shared, false);
  close();
});

test("sharing mutations reject cross-site requests and other workspaces without enumeration", async () => {
  const { db, close } = sharingDatabase();
  let authorizations = 0;
  const crossSite = await updateReportSharing(new Request(`https://signal.example/api/reports/${publicId}/sharing`, {
    method: "POST", headers: { origin: "https://attacker.example", "content-type": "application/json" }, body: JSON.stringify({ action: "share" }),
  }), { params: { publicId } }, sharingDependencies(db, { authorize: async () => { authorizations += 1; return owner; } }));
  assert.equal(crossSite.status, 403);
  assert.equal(authorizations, 0);

  const denied = await getReportSharing(new Request(`https://signal.example/api/reports/${publicId}/sharing`), { params: { publicId } }, sharingDependencies(db, {
    authorize: async () => ({ ...owner, workspaceId: "workspace-other" }),
  }));
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { ok: false, error: "Report not found.", errorCode: "not-found" });
  close();
});

function storedReport() {
  return {
    run: {
      id: "run-secret",
      publicId,
      primaryDomain: "shop.example",
      locale: "en",
      status: "complete",
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T11:00:00.000Z",
      workspaceId: "workspace-secret",
      billingReservationId: "billing-secret",
      errorCode: "internal-code",
      errorMessage: "internal-message",
    },
    events: [{ metadata: { secret: true } }],
    document: { document: { version: "1", generatedAt: "2026-08-24T11:00:00.000Z", blocks: [] } },
    documentSchemaVersion: 1,
    documentObservedAt: "2026-08-24T11:00:00.000Z",
    primaryProducts: { authoritative: true, totalCount: 1, products: [], truncated: false },
    factManifest: { manifestHash: "internal" },
  };
}

function publicDependencies(overrides = {}) {
  return {
    openDatabase: async () => ({ close() {} }),
    resolveShare: () => ({ runId: "run-1", privatePublicId: publicId }),
    loadReport: async () => storedReport(),
    now: () => now,
    ...overrides,
  };
}

test("shared report payload is allowlisted and public reads are no-store and noindex", async () => {
  const payload = sharedReportPayload(storedReport());
  assert.deepEqual(Object.keys(payload.run).sort(), ["createdAt", "locale", "primaryDomain", "status", "updatedAt"]);
  assert.equal(Object.hasOwn(payload.run, "publicId"), false);
  assert.equal(Object.hasOwn(payload, "factManifest"), false);
  assert.deepEqual(payload.events, []);

  const response = await getSharedReport(new Request(`https://signal.example/api/shared-reports/${token}`), { params: { token } }, publicDependencies());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(Object.hasOwn(body.report.run, "id"), false);
  assert.equal(Object.hasOwn(body.report.run, "publicId"), false);
  assert.equal(Object.hasOwn(body.report.run, "workspaceId"), false);
});

test("malformed, unknown, and revoked share tokens return 404 before report facts are read", async () => {
  let reads = 0;
  for (const candidate of ["bad", token]) {
    const response = await getSharedReport(new Request(`https://signal.example/api/shared-reports/${candidate}`), { params: { token: candidate } }, publicDependencies({
      resolveShare: () => null,
      loadReport: async () => { reads += 1; return storedReport(); },
    }));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).errorCode, "not-found");
  }
  assert.equal(reads, 0);
});

test("shared match pagination uses only the active token and is never cached", async () => {
  const page = { authoritative: true, manifestHash: "manifest", totalCount: 20, directPriceCount: 20, domainCounts: { "rival.example": 20 }, items: [], nextCursor: null };
  const calls = [];
  const response = await getSharedReportMatches(new Request(`https://signal.example/api/shared-reports/${token}/matches?limit=75&cursor=${encodeURIComponent("rival.example~" + "b".repeat(64))}`), { params: { token } }, {
    openDatabase: async () => ({ close() {} }),
    resolveShare: () => ({ runId: "run-1", privatePublicId: publicId }),
    loadMatchPage: async (id, input) => { calls.push({ id, input }); return page; },
    now: () => now,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("etag"), null);
  assert.deepEqual(calls, [{ id: publicId, input: { cursor: "rival.example~" + "b".repeat(64), limit: 75 } }]);

  const denied = await getSharedReportMatches(new Request(`https://signal.example/api/shared-reports/${token}/matches`), { params: { token } }, {
    openDatabase: async () => ({ close() {} }), resolveShare: () => null, loadMatchPage: async () => { throw new Error("must not read"); }, now: () => now,
  });
  assert.equal(denied.status, 404);
});
