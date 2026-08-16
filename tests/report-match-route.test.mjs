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

test("public match route returns an immutable authoritative page and forwards pagination", async () => {
  const calls = [];
  const response = await publicReportMatches(
    new Request(`https://signal.example/api/reports/${publicId}/matches?limit=75&cursor=${encodeURIComponent(page.nextCursor)}`),
    { params: Promise.resolve({ publicId }) },
    async (id, input) => { calls.push({ id, input }); return page; },
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
    async () => page,
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
      async () => { throw new Error(message); },
    );
    const body = await response.json();
    assert.equal(response.status, status);
    assert.equal(body.errorCode, errorCode);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(body.error, /database secret leaked/);
  }
});
