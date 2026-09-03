import assert from "node:assert/strict";
import test from "node:test";

import { publicReportMatches } from "../app/api/reports/[publicId]/matches/route.ts";

const publicId = "a".repeat(32);
const page = {
  authoritative: true,
  manifestHash: "manifest-1",
  totalCount: 232,
  directPriceCount: 80,
  domainCounts: { "rival.example": 232 },
  items: [{ primary: {}, rival: {}, match: {}, key: "match-1" }],
  nextCursor: "rival.example~" + "b".repeat(64),
};

function dependencies(overrides = {}) {
  return {
    now: () => new Date("2026-08-24T12:00:00.000Z"),
    loadAccess: async () => ({
      runId: "run-1",
      publicId,
      workspaceId: "",
      expiresAt: "2026-09-24T00:00:00.000Z",
    }),
    loadMatchPage: async () => page,
    authorize: async () => null,
    allowLegacyPublic: () => true,
    ...overrides,
  };
}

test("public match route returns an immutable authoritative page and forwards pagination", async () => {
  const calls = [];
  const response = await publicReportMatches(
    new Request(`https://signal.example/api/reports/${publicId}/matches?limit=75&cursor=${encodeURIComponent(page.nextCursor)}`),
    { params: Promise.resolve({ publicId }) },
    dependencies({ loadMatchPage: async (id, input) => { calls.push({ id, input }); return page; } }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /immutable/);
  assert.equal(response.headers.get("etag"), '"manifest-1:match-1:match-1"');
  assert.deepEqual(calls, [{ id: publicId, input: { cursor: page.nextCursor, limit: 75 } }]);
  assert.deepEqual(await response.json(), { ok: true, page });
});

test("public match route honors matching ETags without returning a body", async () => {
  const etag = '"manifest-1:match-1:match-1"';
  const response = await publicReportMatches(
    new Request(`https://signal.example/api/reports/${publicId}/matches`, { headers: { "if-none-match": etag } }),
    { params: { publicId } },
    dependencies(),
  );
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), etag);
  assert.equal(await response.text(), "");
});

test("public match route exposes safe request and fallback states", async () => {
  for (const [message, status, errorCode] of [
    ["Invalid report match cursor.", 400, "invalid-request"],
    ["Report not found.", 404, "not-found"],
    ["Authoritative report match facts are unavailable.", 409, "facts-unavailable"],
    ["database secret leaked", 503, "storage-read-failed"],
  ]) {
    const response = await publicReportMatches(
      new Request(`https://signal.example/api/reports/${publicId}/matches`),
      { params: { publicId } },
      dependencies({ loadMatchPage: async () => { throw new Error(message); } }),
    );
    const body = await response.json();
    assert.equal(response.status, status);
    assert.equal(body.errorCode, errorCode);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.doesNotMatch(body.error, /database secret leaked/);
  }
});

test("owned match pages require the owning workspace and are never publicly cached", async () => {
  let reads = 0;
  const owned = dependencies({
    loadAccess: async () => ({ runId: "run-1", publicId, workspaceId: "workspace-1", expiresAt: "2026-09-24T00:00:00.000Z" }),
    authorize: async () => ({ user: { id: "user-1", name: "Owner", email: "owner@example.com" }, workspaceId: "workspace-1" }),
    loadMatchPage: async () => { reads += 1; return page; },
  });
  const response = await publicReportMatches(new Request(`https://signal.example/api/reports/${publicId}/matches`), { params: { publicId } }, owned);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Cookie, Authorization");
  assert.equal(response.headers.get("etag"), null);
  assert.equal(reads, 1);

  const denied = await publicReportMatches(
    new Request(`https://signal.example/api/reports/${publicId}/matches`),
    { params: { publicId } },
    { ...owned, authorize: async () => ({ user: { id: "user-2", name: "Other", email: "other@example.com" }, workspaceId: "workspace-2" }) },
  );
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).errorCode, "not-found");
  assert.equal(reads, 1);
});

test("expired legacy match pages are not readable", async () => {
  const response = await publicReportMatches(
    new Request(`https://signal.example/api/reports/${publicId}/matches`),
    { params: { publicId } },
    dependencies({ loadAccess: async () => ({ runId: "run-1", publicId, workspaceId: "", expiresAt: "2026-08-24T11:59:59.000Z" }) }),
  );
  assert.equal(response.status, 404);
});

test("hosted deployments require an explicit share token for legacy match facts", async () => {
  let reads = 0;
  const response = await publicReportMatches(
    new Request(`https://signal.example/api/reports/${publicId}/matches`),
    { params: { publicId } },
    dependencies({ allowLegacyPublic: () => false, loadMatchPage: async () => { reads += 1; return page; } }),
  );
  assert.equal(response.status, 404);
  assert.equal(reads, 0);
});
