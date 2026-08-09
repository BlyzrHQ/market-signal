import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createHumanReviewQueueHandler } from "../app/api/internal/human-reviews/route.ts";
import { createHumanReviewResponseHandler } from "../app/api/internal/human-reviews/[requestId]/response/route.ts";
import { ReportEvaluationStateError } from "../app/lib/report-store.ts";
import { encodeHumanReviewCursor, parseHumanReviewCursor } from "../src/shared/report-human-review-contract.ts";

const TOKEN = "owner-route-token-that-is-at-least-32-characters";
const WRITE_TOKEN = "owner-write-token-that-is-at-least-32-characters";
const CALLBACK_TOKEN = "callback-token-that-is-at-least-32-characters";
const TOKENS = { read: TOKEN, write: WRITE_TOKEN, callback: CALLBACK_TOKEN };
const REQUEST_ID = "94af318d-e5cc-4b8d-b4d4-7225722d41fc";

test("owner queue requires its distinct strong token and validates bounded query options", async () => {
  const calls = [];
  const handler = createHumanReviewQueueHandler({ async list(options) { calls.push(options); return { items: [], hasMore: false, nextCursor: null }; } }, TOKENS);
  assert.equal((await handler(new Request("https://market.example/api/internal/human-reviews"))).status, 401);
  assert.equal((await handler(new Request("https://market.example/api/internal/human-reviews", { headers: { authorization: "Bearer callback-token-is-not-the-owner-token" } }))).status, 401);
  const equalCredentials = { read: TOKEN, write: TOKEN, callback: CALLBACK_TOKEN };
  assert.equal((await createHumanReviewQueueHandler({ async list() { throw new Error("must not run"); } }, equalCredentials)(new Request("https://market.example/api/internal/human-reviews", { headers: { authorization: `Bearer ${TOKEN}` } }))).status, 401);
  assert.equal((await handler(new Request("https://market.example/api/internal/human-reviews?status=bad", { headers: { authorization: `Bearer ${TOKEN}` } }))).status, 400);
  assert.equal((await handler(new Request("https://market.example/api/internal/human-reviews?limit=51", { headers: { authorization: `Bearer ${TOKEN}` } }))).status, 400);
  const cursor = encodeHumanReviewCursor({ queueSeq: 42 });
  const accepted = await handler(new Request(`https://market.example/api/internal/human-reviews?limit=7&cursor=${cursor}`, { headers: { authorization: `Bearer ${TOKEN}` } }));
  assert.equal(accepted.status, 200);
  assert.deepEqual(calls[0], { limit: 7, afterQueueSeq: 42 });
  assert.deepEqual(parseHumanReviewCursor(cursor), { queueSeq: 42 });
});

test("owner response route rejects malformed or oversized input and maps immutable conflicts", async () => {
  const handler = createHumanReviewResponseHandler({ async respond() { throw new ReportEvaluationStateError("human-review-response-conflict", "conflict", 409); } }, TOKENS);
  const context = { params: { requestId: REQUEST_ID } };
  const request = (body, authorization = `Bearer ${WRITE_TOKEN}`, headers = {}) => new Request(`https://market.example/api/internal/human-reviews/${REQUEST_ID}/response`, { method: "PUT", headers: { authorization, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  assert.equal((await handler(request({}, "Bearer wrong"), context)).status, 401);
  assert.equal((await handler(request({}, `Bearer ${TOKEN}`), context)).status, 401);
  assert.equal((await handler(request({}, `Bearer ${CALLBACK_TOKEN}`), context)).status, 401);
  assert.equal((await handler(request("{"), context)).status, 400);
  assert.equal((await handler(request({ action: "respond", idempotencyKey: "owner:1", resolutionCode: "yes", answerText: "" }), context)).status, 400);
  assert.equal((await handler(request({ action: "respond", idempotencyKey: "owner:1", resolutionCode: "unable_to_determine", answerText: "not empty" }), context)).status, 400);
  assert.equal((await handler(request({ action: "respond", idempotencyKey: "owner:1", resolutionCode: "answered", answerText: "<script>alert(1)</script>" }), context)).status, 400);
  assert.equal((await handler(request({ action: "respond", idempotencyKey: "owner:1", resolutionCode: "answered", answerText: "See https://malicious.example" }), context)).status, 400);
  assert.equal((await handler(request({ action: "respond", idempotencyKey: "owner:1", resolutionCode: "answered", answerText: "Yes." }, undefined, { "content-length": "4097" }), context)).status, 400);
  const conflict = await handler(request({ action: "respond", idempotencyKey: "owner:1", resolutionCode: "answered", answerText: "Yes, useful." }), context);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "human-review-response-conflict");
});

test("owner response route passes only the closed immutable response contract", async () => {
  const calls = [];
  const handler = createHumanReviewResponseHandler({ async respond(id, input) { calls.push({ id, input }); return { replayed: false, response: { id: "response-1" } }; } }, TOKENS);
  const response = await handler(new Request(`https://market.example/api/internal/human-reviews/${REQUEST_ID}/response`, { method: "PUT", headers: { authorization: `Bearer ${WRITE_TOKEN}` }, body: JSON.stringify({ action: "respond", idempotencyKey: "owner:answer-1", resolutionCode: "answered", answerText: "Needs a product owner." }) }), { params: Promise.resolve({ requestId: REQUEST_ID }) });
  assert.equal(response.status, 201);
  assert.deepEqual(calls, [{ id: REQUEST_ID, input: { action: "respond", idempotencyKey: "owner:answer-1", resolutionCode: "answered", answerText: "Needs a product owner." } }]);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("public report routes do not import or expose the private human-review queue", async () => {
  const sources = await Promise.all([
    readFile(new URL("../app/api/reports/[publicId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/reports/[publicId]/matches/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(sources.join("\n"), /humanReview|human-review|reportHumanReview/i);
});
