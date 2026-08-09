import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createEvaluationFeedbackAckHandler } from "../app/api/internal/evaluation-feedback/ack/route.ts";
import { createEvaluationFeedbackClaimHandler } from "../app/api/internal/evaluation-feedback/claim/route.ts";
import { ReportEvaluationStateError } from "../app/lib/report-store.ts";
import { REPORT_FEEDBACK_CONSUMER } from "../src/shared/report-feedback-contract.ts";

const READ = "monitor-read-token-that-is-at-least-32-characters";
const ACK = "monitor-ack-token-that-is-at-least-32-characters";
const TOKENS = {
  read: READ,
  acknowledge: ACK,
  ownerRead: "owner-read-token-that-is-at-least-32-characters",
  ownerWrite: "owner-write-token-that-is-at-least-32-characters",
  callback: "callback-token-that-is-at-least-32-characters",
};
const BODY = { action: "claim", consumer: REPORT_FEEDBACK_CONSUMER };

function request(url, body, token, method = "POST") {
  return new Request(url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("feedback claim uses a dedicated credential and a closed bounded contract", async () => {
  let calls = 0;
  const handler = createEvaluationFeedbackClaimHandler({ async claim() { calls += 1; return { item: null, leaseId: null, payloadHash: null, backlog: { pending: 0, oldestAt: null } }; } }, TOKENS);
  const url = "https://market.example/api/internal/evaluation-feedback/claim";
  assert.equal((await handler(request(url, BODY, TOKENS.ownerRead))).status, 401);
  assert.equal((await handler(request(url, BODY, TOKENS.callback))).status, 401);
  assert.equal((await handler(request(url, { ...BODY, extra: true }, READ))).status, 400);
  assert.equal((await handler(new Request(url, { method: "POST", headers: { authorization: `Bearer ${READ}`, "content-length": "513" }, body: "{}" }))).status, 400);
  const equal = { ...TOKENS, acknowledge: READ };
  assert.equal((await createEvaluationFeedbackClaimHandler({ async claim() { throw new Error("must not run"); } }, equal)(request(url, BODY, READ))).status, 401);
  const accepted = await handler(request(url, BODY, READ));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.equal(calls, 1);
});

test("feedback acknowledgement uses the ACK credential and maps immutable conflicts", async () => {
  const url = "https://market.example/api/internal/evaluation-feedback/ack";
  const body = { action: "acknowledge", consumer: REPORT_FEEDBACK_CONSUMER, deliveryId: "delivery-1", leaseId: "lease-1", payloadHash: "a".repeat(64), idempotencyKey: "codex:delivery:1" };
  const calls = [];
  const accepted = createEvaluationFeedbackAckHandler({ async acknowledge(input) { calls.push(input); return { replayed: false, receiptId: "receipt-1", acknowledgedAt: "2026-08-09T00:00:00.000Z" }; } }, TOKENS);
  assert.equal((await accepted(request(url, body, READ, "PUT"))).status, 401);
  assert.equal((await accepted(request(url, { ...body, payloadHash: "bad" }, ACK, "PUT"))).status, 400);
  assert.equal((await accepted(request(url, body, ACK, "PUT"))).status, 201);
  assert.equal(calls.length, 1);
  const conflict = createEvaluationFeedbackAckHandler({ async acknowledge() { throw new ReportEvaluationStateError("evaluation-feedback-ack-conflict", "conflict", 409); } }, TOKENS);
  const response = await conflict(request(url, body, ACK, "PUT"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "evaluation-feedback-ack-conflict");
});

test("public report routes do not expose the owner feedback delivery API", async () => {
  const sources = await Promise.all([
    readFile(new URL("../app/api/reports/[publicId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/reports/[publicId]/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(sources.join("\n"), /evaluationFeedback|evaluation-feedback/i);
});
